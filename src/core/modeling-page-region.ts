/**
 * P8.2：Page Region Classification（deterministic，无 LLM）。
 *
 * 目标：区分页面区域，让 assertion/option 建模只消费业务区域，避免 GLOBAL_NAV / HEADER /
 * FOOTER 噪音进入 Page Model。
 *
 * 信号（全部来自客观 DOM 结构）：
 *   - landmark role（banner/navigation/main/contentinfo/complementary/form/dialog）
 *   - 语义 tag（header/nav/footer/aside/main/table/form）
 *   - fixed/sticky 定位（类名 / style 信号）
 *   - URL link density（href 占比高 → 导航）
 *   - region 文本密度（长文案 → footer/utility）
 *   - form association（input 在 form 内 → FORM_REGION）
 *   - table/list ancestry（在 table/grid 内 → RESULT_REGION）
 *
 * 不做：LLM 第一层分类、页面特例、按 pageId 硬编码。
 *
 * 输出：regionType + confidence + evidence[]（可审计）。
 */

export type PageRegionType =
  | "BUSINESS_MAIN"
  | "GLOBAL_NAV"
  | "HEADER"
  | "FOOTER"
  | "SIDEBAR"
  | "UTILITY"
  | "MODAL"
  | "DRAWER"
  | "RESULT_REGION"
  | "FILTER_REGION"
  | "FORM_REGION"
  | "UNKNOWN";

export interface RegionInput {
  /** 元素自身的角色/标签/类名/文本等。 */
  tag?: string;
  role?: string;
  id?: string;
  classes?: string;
  href?: string;
  text?: string;
  /** DOM ancestry（从根到自身的 tag/role 链，例如 ["body","main","section","table","tbody","tr"]）。 */
  ancestry?: string[];
  /** 是否处于 form 内（祖先含 <form> 或 role=form）。 */
  inForm?: boolean;
  /** 祖先是否含 modal/drawer 容器。 */
  inDialog?: boolean;
  /** 祖先是否含 table/grid/list 容器。 */
  inTable?: boolean;
  /** 祖先是否含 nav/header/footer 容器。 */
  inNavContainer?: boolean;
  /** 链接密度信号（0..1）：容器内 href 元素占比。 */
  linkDensity?: number;
  /** 是否为固定/吸顶容器。 */
  fixedOrSticky?: boolean;
}

export interface RegionClassification {
  regionType: PageRegionType;
  confidence: number;
  evidence: string[];
}

const LANDMARK_ROLE_TO_REGION: Record<string, PageRegionType> = {
  banner: "HEADER",
  navigation: "GLOBAL_NAV",
  main: "BUSINESS_MAIN",
  contentinfo: "FOOTER",
  complementary: "SIDEBAR",
  form: "FORM_REGION",
  search: "UTILITY",
  dialog: "MODAL"
};

const TAG_TO_REGION: Record<string, PageRegionType> = {
  header: "HEADER",
  nav: "GLOBAL_NAV",
  footer: "FOOTER",
  aside: "SIDEBAR",
  main: "BUSINESS_MAIN",
  form: "FORM_REGION",
  table: "RESULT_REGION"
};

const UTILITY_TEXT_PATTERNS = [/^登录|^注册|^退出|^设置|^帮助|^客服|^反馈|^通知|^消息|^搜索|^语言|^下载/i];

/**
 * P8.2：确定性区域分类。
 *
 * 优先级（高 → 低）：
 *   1. 祖先容器信号（nav/header/footer/modal/table）——最可靠；
 *   2. landmark role / 语义 tag；
 *   3. 链接密度（>0.5 且无 form/table 上下文 → GLOBAL_NAV）；
 *   4. 文本/工具性信号。
 */
export function classifyPageRegion(input: RegionInput): RegionClassification {
  const evidence: string[] = [];
  const { ancestry = [], tag, role, inForm, inDialog, inTable, inNavContainer, linkDensity, fixedOrSticky, text } = input;

  // 1a. modal / drawer：祖先含 dialog 容器
  if (inDialog) {
    evidence.push("ancestor=dialog");
    const drawerLike = ancestry.some((a) => /drawer|sidenav|side_panel/i.test(a));
    return { regionType: drawerLike ? "DRAWER" : "MODAL", confidence: 0.9, evidence };
  }

  // 1b. nav/header/footer 容器
  if (inNavContainer) {
    evidence.push("ancestor=nav_container");
    const kind = ancestry.find((a) => /^nav$/i.test(a) || /^header$/i.test(a) || /^footer$/i.test(a));
    if (kind && /^footer$/i.test(kind)) return { regionType: "FOOTER", confidence: 0.9, evidence };
    if (kind && /^header$/i.test(kind)) return { regionType: "HEADER", confidence: 0.9, evidence };
    return { regionType: "GLOBAL_NAV", confidence: 0.85, evidence };
  }

  // 1c. table/grid 容器
  if (inTable) {
    evidence.push("ancestor=table");
    return { regionType: "RESULT_REGION", confidence: 0.85, evidence };
  }

  // 2. landmark role / tag
  if (role && LANDMARK_ROLE_TO_REGION[role]) {
    evidence.push(`role=${role}`);
    return { regionType: LANDMARK_ROLE_TO_REGION[role], confidence: 0.9, evidence };
  }
  const normTag = String(tag ?? "").toLowerCase();
  if (normTag && TAG_TO_REGION[normTag]) {
    evidence.push(`tag=${normTag}`);
    return { regionType: TAG_TO_REGION[normTag], confidence: 0.85, evidence };
  }

  // 3. form association
  if (inForm || normTag === "input" || normTag === "select" || normTag === "button") {
    if (inForm) {
      evidence.push("ancestor=form");
      return { regionType: "FORM_REGION", confidence: 0.8, evidence };
    }
  }

  // 4. fixed/sticky + 链接密度 → 导航/工具条
  const density = typeof linkDensity === "number" ? linkDensity : 0;
  if (fixedOrSticky && density > 0.5) {
    evidence.push("fixed_or_sticky=true", `link_density=${density.toFixed(2)}`);
    return { regionType: "GLOBAL_NAV", confidence: 0.7, evidence };
  }
  if (density > 0.7) {
    evidence.push(`link_density=${density.toFixed(2)}`);
    return { regionType: "GLOBAL_NAV", confidence: 0.65, evidence };
  }

  // 5. utility 文本信号
  const textNorm = String(text ?? "");
  if (textNorm && UTILITY_TEXT_PATTERNS.some((p) => p.test(textNorm))) {
    evidence.push("utility_text_pattern");
    return { regionType: "UTILITY", confidence: 0.6, evidence };
  }

  evidence.push("no_strong_region_signal");
  return { regionType: "UNKNOWN", confidence: 0.3, evidence };
}

/** P8.3：assertion candidate 是否允许进入（按 region 门禁）。 */
export function isRegionAllowedForAssertion(regionType: PageRegionType, purpose?: string): boolean {
  if (regionType === "BUSINESS_MAIN" || regionType === "RESULT_REGION" || regionType === "FILTER_REGION" || regionType === "FORM_REGION" || regionType === "MODAL" || regionType === "DRAWER") {
    return true;
  }
  if (regionType === "UTILITY") {
    // 只允许明确的 control-state assertion（如 download button enabled）
    return purpose === "CONTROL_STATE";
  }
  if (regionType === "UNKNOWN" && purpose === "CONTROL_STATE") {
    // 无法判定区域但非导航名称的控件状态 → 放行（nav 噪音已由名称过滤器拦截）
    return true;
  }
  // GLOBAL_NAV / HEADER / FOOTER / SIDEBAR → 默认排除
  return false;
}
