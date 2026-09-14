import { apiJson } from "./src/api.js";

const $ = (id) => document.getElementById(id);
let projectCatalog = [];
let webExploreRunning = false;
let currentAssistantPlan = null;
let currentCaseAssets = [];
let currentProjectKnowledgeMap = null;
let assistantActionStage = "idle";
let assistantActionSignature = "";
let assistantAbortController = null;
let assistantRequestToken = 0;
let assistantExecutionInFlight = false;
let assistantStepProgressTimer = null;
let assistantContextDraftProject = "";
let assistantContextDraftEnv = "";
let assistantPlanningStageEvents = [];
let assistantExecutionRequestId = "";
let currentCaseRunTrace = null;
let currentCaseDslTrace = null;
let currentCaseDslGenerationRunId = "";
let caseDslGenerationCancelInFlight = false;
let currentCaseExecutionRunId = "";
let caseExecutionCancelInFlight = false;
let currentSelectedCaseId = "";
let currentCasePage = 1;
let currentAccountProfilePayload = null;
let currentSelectedAccountProfileUsername = "";
let currentAccountTotpReadiness = new Map();
let currentDatabaseSchema = null;
let currentDatabaseModel = null;
let currentDatabaseSourceId = "workbench_sqlite";
let currentDatabaseTableName = "";
let currentProjectCapabilities = null;
const CASE_PAGE_SIZE = 10;
const ASSISTANT_DEFAULT_PROJECT = "demo";
const ASSISTANT_DEFAULT_ENV = "test";

installWorkbenchShell();

document.querySelectorAll(".nav").forEach((button) => {
  button.addEventListener("click", () => {
    activateView(button.dataset.view);
  });
});

function activateView(viewId) {
  if (!viewId || !$(viewId)) return;
  document.querySelectorAll(".nav").forEach((item) => item.classList.toggle("active", item.dataset.view === viewId));
  document.querySelectorAll(".view").forEach((item) => item.classList.toggle("active", item.id === viewId));
  if (viewId === "projectKnowledge") loadProjectKnowledgeMap();
  if (viewId === "projectCapabilities") loadProjectCapabilities();
  if (viewId === "knowledgeProposals") loadKnowledgeProposalList();
  if (viewId === "accounts") refreshAccountArea();
  if (viewId === "accountFactory") loadAccountFactoryCapabilities();
  if (viewId === "database") loadDatabaseWorkbenchSchema();
}

$("project").addEventListener("change", () => {
  syncEnvOptions();
  syncWorkbenchCommandContext();
  prefillExploreUrl();
  clearExploreAccountFields();
  refresh();
});
$("env").addEventListener("change", () => {
  syncWorkbenchCommandContext();
  prefillExploreUrl();
  clearExploreAccountFields();
  refresh();
});
$("webSurface").addEventListener("change", prefillExploreUrl);
$("exploreIntensity").addEventListener("change", applyExploreIntensityPreset);
$("exploreStrategy").addEventListener("change", applyExploreIntensityPreset);
$("webDepth").addEventListener("input", markExploreCustom);
$("webPages").addEventListener("input", markExploreCustom);
$("webButtonBudget").addEventListener("input", markExploreCustom);
$("clickButtons").addEventListener("change", markExploreCustom);
$("refresh").addEventListener("click", refresh);
$("searchKnowledge").addEventListener("click", searchKnowledge);
$("exploreAccount").addEventListener("change", fillExploreAccount);
$("saveAccount").addEventListener("click", saveAccount);
$("cancelAccountEdit").addEventListener("click", clearAccountEditForm);
$("addAccount").addEventListener("click", () => openAccountModal());
$("resetAccountFilters").addEventListener("click", resetAccountFilters);
$("closeAccountModal").addEventListener("click", closeAccountModal);
$("cancelAccountModal").addEventListener("click", closeAccountModal);
$("saveAccountModal").addEventListener("click", saveAccountFromModal);
$("accountModalProject").addEventListener("change", syncAccountModalEnvOptions);
$("closeAccountGaModal")?.addEventListener("click", closeAccountGaModal);
$("closeAccountProfileModal")?.addEventListener("click", closeAccountProfileModal);
$("closeConfirmPlanModal").addEventListener("click", closeConfirmPlanModal);
$("cancelExecutePlan").addEventListener("click", closeConfirmPlanModal);
$("confirmExecutePlan").addEventListener("click", () => {
  closeConfirmPlanModal();
  executeAssistantPlanV3(true);
});
$("filterAccounts").addEventListener("click", refreshAccountArea);
$("refreshAccountProfiles")?.addEventListener("click", () => refreshAccountProfilesFromDatabase());
$("refreshSelectedAccountProfile")?.addEventListener("click", () => refreshAccountProfilesFromDatabase(currentSelectedAccountProfileUsername || $("accountKeyword")?.value?.trim() || ""));
$("saveEnvironment").addEventListener("click", saveEnvironmentDiscovery);
$("assistantSend").addEventListener("click", handleAssistantPrimaryAction);
$("assistantExecute")?.addEventListener("click", executeAssistantPlanV3);
$("saveLarkSettings")?.addEventListener("click", saveLarkSettings);
$("sendLarkTest")?.addEventListener("click", sendLarkTest);
$("simulateVerification")?.addEventListener("click", simulateVerification);
$("refreshVerificationInbox")?.addEventListener("click", loadVerificationInbox);
$("refreshLogs")?.addEventListener("click", loadLogs);
$("refreshTasks").addEventListener("click", loadTasks);
$("refreshCases")?.addEventListener("click", loadCases);
$("generateCaseDsl")?.addEventListener("click", () => generateSelectedCaseDsl(false));
$("pauseCaseDslGeneration")?.addEventListener("click", cancelCaseDslGeneration);
$("executeCases")?.addEventListener("click", executeSelectedCases);
$("startBootstrapScan")?.addEventListener("click", startBootstrapScan);
$("preflightBootstrapScan")?.addEventListener("click", () => startBootstrapScan(true));
$("importBootstrapReview")?.addEventListener("click", importBootstrapReview);
$("runTests").addEventListener("click", () =>
  postAction(
    "/api/actions/run-tests",
    {
      project: $("project").value,
      env: $("env").value,
      tags: $("runTags").value,
      type: $("runType").value,
      caseId: $("runCase").value,
      mode: $("runMode").value,
      maxAiCalls: $("runMaxAiCalls").value,
      maxAiTokens: $("runMaxAiTokens").value,
      maxEstimatedCost: $("runMaxEstimatedCost").value,
      maxStepHealingLevel: $("runMaxStepHealingLevel").value,
      dryRun: $("dryRun").checked
    },
    "runConsoleOutput"
  )
);
$("exploreWeb").addEventListener("click", toggleWebExplore);
$("uploadApp").addEventListener("click", uploadAppArchive);
$("exploreApp").addEventListener("click", () =>
  postAction(
    "/api/actions/explore-app",
    {
      project: $("project").value,
      env: $("env").value,
      apk: $("apk").value,
      appPackage: $("appPackage").value,
      appActivity: $("appActivity").value,
      deviceId: $("deviceId").value,
      maxDepth: $("appDepth").value,
      maxPages: $("appPages").value
    },
    "exploreConsoleOutput"
  )
);

function installWorkbenchShell() {
  document.body.classList.add("workbench-shell");
  const brand = document.querySelector(".brand");
  if (brand) {
    brand.innerHTML = `
      <span class="brand-mark">AT</span>
      <div>
        <strong>Auto Test</strong>
        <span>Workbench</span>
      </div>
      <button id="sidebarToggle" type="button" class="sidebar-toggle" title="收起/展开导航">‹</button>`;
  }
  const nav = document.querySelector("aside nav");
  if (nav) {
    nav.innerHTML = `
      <div class="nav-section-label">Main</div>
      <button class="nav active" data-view="assistant"><span class="nav-icon">AI</span><span>AI 助手</span></button>
      <button class="nav" data-view="cases"><span class="nav-icon">CS</span><span>用例中心</span></button>
      <button class="nav" data-view="projectKnowledge"><span class="nav-icon">KM</span><span>项目知识地图</span></button>
      <button class="nav" data-view="projectCapabilities"><span class="nav-icon">CP</span><span>项目能力</span></button>
      <button class="nav" data-view="knowledgeProposals"><span class="nav-icon">PR</span><span>知识审核</span></button>
      <button class="nav" data-view="accounts"><span class="nav-icon">AC</span><span>账号管理</span></button>
      <button class="nav" data-view="accountFactory"><span class="nav-icon">AF</span><span>账号工厂</span></button>
      <button class="nav" data-view="database"><span class="nav-icon">DB</span><span>数据库</span></button>
      <details class="side-advanced" open>
        <summary>Advanced</summary>
        <button class="nav" data-view="run"><span class="nav-icon">RN</span><span>执行记录</span></button>
        <button class="nav" data-view="bootstrap"><span class="nav-icon">BM</span><span>初始化建模</span></button>
        <button class="nav" data-view="verifications"><span class="nav-icon">VF</span><span>验证码监听</span></button>
        <button class="nav" data-view="environment"><span class="nav-icon">EV</span><span>环境管理</span></button>
      </details>`;
  }
  const topbar = document.querySelector(".topbar");
  if (topbar) {
    topbar.classList.add("workbench-topbar");
    const title = topbar.querySelector("h1");
    const subtitle = topbar.querySelector("p");
    if (title) title.textContent = "Auto Test Workbench";
    if (subtitle) subtitle.remove();
    const envStrip = topbar.querySelector(".env-strip");
    if (envStrip) {
      const refreshButton = $("refresh");
      if (refreshButton) refreshButton.textContent = "同步";
    }
  }
  installCaseCenterView();
  installProjectKnowledgeMapView();
  installProjectCapabilitiesView();
  installKnowledgeProposalReviewView();
  installAccountFactoryView();
  installDatabaseWorkbenchView();
  installWorkbenchAssistantView();
  $("sidebarToggle")?.addEventListener("click", () => {
    document.body.classList.toggle("sidebar-collapsed");
    $("sidebarToggle").textContent = document.body.classList.contains("sidebar-collapsed") ? "›" : "‹";
  });
  document.querySelectorAll(".view").forEach((item) => item.classList.remove("active"));
  $("assistant")?.classList.add("active");
}

function installWorkbenchAssistantView() {
  const assistant = $("assistant");
  if (!assistant) return;
  assistant.innerHTML = `
    <section class="workbench-page assistant-workbench">
      <div class="workbench-page-head">
        <div>
          <h2>AI 助手</h2>
        </div>
        <label class="observation-toggle page-head-observation-toggle" title="开启后采集每步截图、DOM 和失败视频；普通执行建议关闭。">
          <input id="assistantObservationMode" type="checkbox" />
          <span>执行观测</span>
        </label>
      </div>

      <section class="assistant-grid assistant-grid-single">
        <section class="workspace-panel assistant-center">
          <div class="panel-header">
            <strong>Conversation / Plan Trace</strong>
            <span id="assistantStatus">等待需求。</span>
          </div>
          <div id="assistantConversation" class="conversation-stream workbench-conversation" aria-live="polite">
            <div id="assistantEmptyState" class="workbench-empty">
              <strong>输入需求开始</strong>
              <p>计划生成后会在这里展示意图理解、证据选择、DSL 明细和执行反馈。</p>
            </div>
          </div>
          <div class="assistant-data-sinks" hidden>
            <div id="assistantPlanOverview">等待生成。</div>
            <div id="assistantAssertionUnderstanding">等待生成计划。</div>
            <div id="assistantAssertionResults">等待执行。</div>
            <pre id="assistantPlan">等待生成。</pre>
            <div class="assistant-trace" id="assistantTrace"></div>
            <table><tbody id="assistantKnowledgeRows"></tbody></table>
          </div>
        </section>
        <aside class="workspace-panel assistant-run-history-panel">
          <div class="panel-header">
            <strong>历史执行记录</strong>
            <span id="assistantRunHistoryStatus">等待加载。</span>
          </div>
          <div id="assistantRunHistoryList" class="assistant-run-history-list"></div>
        </aside>
      </section>


      <section class="command-bar">
        <div class="command-history">
          <button id="assistantHistoryToggle" type="button" class="history-toggle" title="历史需求">H</button>
          <div id="assistantHistoryMenu" class="history-menu hidden"></div>
        </div>
        <label class="command-input">需求
          <textarea id="assistantMessage" rows="2" placeholder="输入自动化测试需求，包含页面、动作和期望结果"></textarea>
        </label>
        <div class="context-picker">
          <button id="assistantContextButton" type="button" class="context-picker-button">
            <span>项目</span><strong data-context-project>demo</strong>
            <span>环境</span><strong data-context-env>test</strong>
          </button>
          <div id="assistantContextPopover" class="context-popover hidden">
            <div class="context-popover-columns">
              <section>
                <strong>项目</strong>
                <div id="assistantProjectChoices" class="context-choice-list"></div>
              </section>
              <section>
                <strong>环境</strong>
                <div id="assistantEnvChoices" class="context-choice-list"></div>
              </section>
            </div>
            <div id="assistantContextNotice" class="context-popover-notice"></div>
          </div>
        </div>
        <select id="assistantProject" class="hidden" aria-hidden="true"></select>
        <select id="assistantEnv" class="hidden" aria-hidden="true"></select>
        <div class="command-actions">
          <button id="assistantSend" type="button" class="assistant-primary-action" data-stage="idle">生成计划</button>
          <button id="assistantExecute" type="button" class="secondary-button hidden">执行当前计划</button>
        </div>
      </section>
    </section>`;
  bindAssistantCommandSelectors();
  bindAssistantHistory();
  bindAssistantActionInvalidators();
  updateAssistantPrimaryAction("idle");
}

function bindPromptChips() {
  document.querySelectorAll(".prompt-chip").forEach((button) => {
    button.addEventListener("click", () => {
      const prompt = button.getAttribute("data-prompt") ?? "";
      if ($("assistantMessage")) $("assistantMessage").value = prompt;
    });
  });
}

function bindAssistantCommandSelectors() {
  $("assistantProject")?.addEventListener("change", () => {
    if ($("project")) $("project").value = $("assistantProject").value;
    syncEnvOptions();
    syncWorkbenchCommandContext();
    resetAssistantActionForInputChange();
    refresh();
  });
  $("assistantEnv")?.addEventListener("change", () => {
    if ($("env")) $("env").value = $("assistantEnv").value;
    syncWorkbenchCommandContext();
    resetAssistantActionForInputChange();
    refresh();
  });
  bindAssistantContextPicker();
}

function bindAssistantActionInvalidators() {
  $("assistantMessage")?.addEventListener("input", resetAssistantActionForInputChange);
}

function bindAssistantContextPicker() {
  $("assistantContextButton")?.addEventListener("click", (event) => {
    event.stopPropagation();
    openAssistantContextPopover();
  });
  $("assistantContextPopover")?.addEventListener("click", (event) => event.stopPropagation());
  $("assistantContextPopover")?.addEventListener("mousedown", (event) => event.stopPropagation());
  document.addEventListener("click", (event) => {
    if (!event.target.closest?.(".context-picker")) $("assistantContextPopover")?.classList.add("hidden");
  });
}

function bindAssistantHistory() {
  renderAssistantHistoryMenu();
  $("assistantHistoryToggle")?.addEventListener("click", (event) => {
    event.stopPropagation();
    $("assistantHistoryMenu")?.classList.toggle("hidden");
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest?.(".command-history")) $("assistantHistoryMenu")?.classList.add("hidden");
  });
}

function assistantRequestHistory() {
  try {
    const value = JSON.parse(localStorage.getItem("autoTestWorkbench.assistantHistory") || "[]");
    return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()).slice(0, 30) : [];
  } catch {
    return [];
  }
}

function saveAssistantRequestHistory(message) {
  const value = String(message || "").trim();
  if (!value) return;
  const next = [value, ...assistantRequestHistory().filter((item) => item !== value)].slice(0, 30);
  localStorage.setItem("autoTestWorkbench.assistantHistory", JSON.stringify(next));
  renderAssistantHistoryMenu();
}

function assistantCurrentSignature() {
  return JSON.stringify({
    project: selectedWorkbenchProject(),
    env: selectedWorkbenchEnv(),
    message: $("assistantMessage")?.value?.trim() || ""
  });
}

function updateAssistantPrimaryAction(stage, options = {}) {
  assistantActionStage = stage;
  const button = $("assistantSend");
  if (!button) return;
  const labels = {
    idle: "生成计划",
    planning: "停止",
    ready: "执行计划",
    executing: "停止",
    executed_passed: "再次执行",
    executed_failed: "再次执行",
    stopping: "停止中"
  };
  const label = options.label || labels[stage] || "生成计划";
  button.innerHTML = formatAssistantActionLabel(label);
  button.disabled = Boolean(options.disabled);
  button.dataset.stage = stage;
  button.classList.remove("is-generate", "is-stop", "is-ready", "is-running", "is-passed", "is-failed");
  const classByStage = {
    idle: "is-generate",
    planning: "is-stop",
    ready: "is-ready",
    executing: "is-stop",
    executed_passed: "is-passed",
    executed_failed: "is-failed",
    stopping: "is-stop"
  };
  button.classList.add(classByStage[stage] ?? "is-generate");
  button.classList.toggle("is-square-action", ["ready", "executed_passed", "executed_failed"].includes(stage));
}

function formatAssistantActionLabel(label) {
  const value = String(label ?? "");
  if (value.length === 4) return `${escapeHtml(value.slice(0, 2))}<br>${escapeHtml(value.slice(2))}`;
  if (value.length === 3) return `${escapeHtml(value.slice(0, 2))}<br>${escapeHtml(value.slice(2))}`;
  return escapeHtml(value);
}

function resetAssistantActionForInputChange() {
  const nextSignature = assistantCurrentSignature();
  if (assistantActionStage === "planning" || assistantActionStage === "executing") return;
  if (nextSignature === assistantActionSignature && currentAssistantPlan) return;
  currentAssistantPlan = null;
  assistantActionSignature = "";
  updateAssistantPrimaryAction("idle");
}

async function handleAssistantPrimaryAction() {
  if (assistantActionStage === "planning") {
    assistantAbortController?.abort();
    assistantAbortController = null;
    assistantRequestToken += 1;
    $("assistantStatus").textContent = "已停止生成计划。";
    updateAssistantPrimaryAction(currentAssistantPlan ? "ready" : "idle");
    return;
  }
  if (assistantActionStage === "executing") {
    await cancelAssistantExecution();
    $("assistantStatus").textContent = "已发送暂停执行请求，等待执行器停止当前链路。";
    updateAssistantPrimaryAction("stopping", { disabled: true });
    return;
  }
  if (assistantExecutionInFlight) return;
  if (assistantActionStage === "ready" || assistantActionStage === "executed_passed" || assistantActionStage === "executed_failed") {
    await executeAssistantPlanV3();
    return;
  }
  await sendAssistantMessageV3();
}

async function cancelAssistantExecution() {
  if (!assistantExecutionRequestId) return;
  await fetch("/api/assistant/execution-cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ executionRequestId: assistantExecutionRequestId })
  }).catch(() => undefined);
}

function cryptoRandomId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function renderAssistantHistoryMenu() {
  const menu = $("assistantHistoryMenu");
  if (!menu) return;
  const history = assistantRequestHistory();
  if (!history.length) {
    menu.innerHTML = `<div class="history-empty">暂无历史需求。</div>`;
    return;
  }
  menu.innerHTML = history
    .map((item, index) => `<button type="button" class="history-item" data-history-index="${index}">${escapeHtml(item)}</button>`)
    .join("");
  menu.querySelectorAll(".history-item").forEach((button) => {
    button.addEventListener("click", () => {
      const item = assistantRequestHistory()[Number(button.dataset.historyIndex)];
      if ($("assistantMessage")) $("assistantMessage").value = item || "";
      resetAssistantActionForInputChange();
      menu.classList.add("hidden");
    });
  });
}

function syncWorkbenchCommandContext() {
  if ($("assistantProject") && $("project")) {
    $("assistantProject").innerHTML = $("project").innerHTML;
    $("assistantProject").value = $("project").value;
  }
  if ($("assistantEnv") && $("env")) {
    $("assistantEnv").innerHTML = $("env").innerHTML;
    $("assistantEnv").value = $("env").value;
  }
  renderAssistantContextButton();
  renderAssistantContextChoices();
  syncCaseContextSelectors();
  document.querySelectorAll("[data-workbench-project]").forEach((item) => { item.textContent = $("project")?.value || "demo"; });
  document.querySelectorAll("[data-workbench-env]").forEach((item) => { item.textContent = $("env")?.value || "test"; });
}

function modernizeAssistantShell() {
  const title = document.querySelector(".topbar h1");
  if (title) title.textContent = "AI 自动化测试平台";
  const subtitle = document.querySelector(".topbar p");
  if (subtitle) subtitle.textContent = "以 AI 助手为入口，统一完成自然语言理解、Page Model 证据选择、DSL 生成与执行反馈。";
  const nav = document.querySelector("aside nav");
  if (nav) {
    nav.innerHTML = `
      <button class="nav active" data-view="assistant">AI 助手</button>
      <button class="nav" data-view="cases">用例中心</button>
      <button class="nav" data-view="projectKnowledge">项目知识地图</button>
      <details class="side-advanced">
        <summary>高级功能</summary>
        <button class="nav" data-view="dashboard">总览</button>
        <button class="nav" data-view="tasks">任务</button>
        <button class="nav" data-view="run">执行</button>
        <button class="nav" data-view="bootstrap">首次建模</button>
        <button class="nav" data-view="graph">页面地图</button>
        <button class="nav" data-view="elements">元素库</button>
        <button class="nav" data-view="accounts">账号管理</button>
        <button class="nav" data-view="verifications">验证码监听</button>
        <button class="nav" data-view="environment">环境管理</button>
      </details>`;
  }
  document.querySelectorAll(".view").forEach((item) => item.classList.remove("active"));
  $("assistant")?.classList.add("active");

  const assistant = $("assistant");
  if (!assistant) return;
  assistant.innerHTML = `
    <section class="assistant-hero">
      <div>
        <h2>AI 自动化助手</h2>
        <p>输入自然语言需求，平台会理解目标、选择 Page Model 证据、生成 DSL，并在执行后展示断言理解与断言结果。</p>
      </div>
      <span class="assistant-env-pill">默认 demo / test</span>
    </section>
    <section class="assistant-workspace">
      <div class="assistant-compose-card">
        <label class="assistant-prompt-label">需求描述
          <textarea id="assistantMessage" rows="7" placeholder="例如：登录demo test环境，进入理财流水页面，交易类型下拉框选择&quot;申购&quot;进行查询，期望列表中仅返回类型为&quot;申购&quot;的数据"></textarea>
        </label>
        <div class="assistant-examples" aria-label="示例需求">
          <button type="button" class="prompt-chip" data-prompt="登录demo test环境，进入现货流水页面，类型选择红包发放进行搜索，期望列表中仅返回类型为红包发放的数据">现货流水筛选</button>
          <button type="button" class="prompt-chip" data-prompt="登录demo test环境，进入理财流水页面，交易类型下拉框选择&quot;申购&quot;进行查询，期望列表中仅返回类型为&quot;申购&quot;的数据">理财流水筛选</button>
          <button type="button" class="prompt-chip" data-prompt="登录demo test环境，进入现货流水页面，币种下拉框选择&quot;ETH&quot;进行查询，期望列表返回空">空列表断言</button>
        </div>
        <div class="button-row assistant-actions">
          <button id="assistantSend" type="button">生成执行计划</button>
          <button id="assistantExecute" type="button" class="secondary-button">执行当前计划</button>
        </div>
        <div class="assistant-status" id="assistantStatus">等待需求。</div>
      </div>
      <div class="assistant-result-grid">
        <section class="assistant-card">
          <h3>计划概览</h3>
          <div id="assistantPlanOverview" class="assistant-card-body">等待生成。</div>
        </section>
        <section class="assistant-card">
          <h3>断言理解</h3>
          <div id="assistantAssertionUnderstanding" class="assistant-card-body">等待生成计划。</div>
        </section>
        <section class="assistant-card">
          <h3>断言结果</h3>
          <div id="assistantAssertionResults" class="assistant-card-body">等待执行。</div>
        </section>
        <section class="assistant-card">
          <h3>执行过程</h3>
          <div class="assistant-trace" id="assistantTrace"></div>
        </section>
        <section class="assistant-card assistant-json-card">
          <h3>DSL 草案</h3>
          <pre id="assistantPlan">等待生成。</pre>
        </section>
        <section class="assistant-card assistant-json-card">
          <h3>命中的知识</h3>
          <div class="table-wrap assistant-knowledge">
            <table>
              <thead><tr><th>标题</th><th>来源</th><th>置信度</th><th>内容</th></tr></thead>
              <tbody id="assistantKnowledgeRows"></tbody>
            </table>
          </div>
        </section>
      </div>
    </section>`;

  upgradeAssistantResultLayout();

  document.querySelectorAll(".prompt-chip").forEach((button) => {
    button.addEventListener("click", () => {
      const prompt = button.getAttribute("data-prompt") ?? "";
      if ($("assistantMessage")) $("assistantMessage").value = prompt;
    });
  });
}

function upgradeAssistantResultLayout() {
  const grid = document.querySelector(".assistant-result-grid");
  if (!grid) return;
  const plan = $("assistantPlanOverview");
  const assertionUnderstanding = $("assistantAssertionUnderstanding");
  const assertionResults = $("assistantAssertionResults");
  const trace = $("assistantTrace");
  const introCard = grid.querySelector(".pixel-message-ai");
  const dslCard = $("assistantPlan")?.closest(".assistant-card");
  const knowledgeCard = $("assistantKnowledgeRows")?.closest(".assistant-card");
  if (!plan || !assertionUnderstanding || !assertionResults || !trace) return;

  const planDetail = assistantDetailSection("\u8ba1\u5212", "\u7b49\u5f85\u751f\u6210", "assistantPlanStatus");
  planDetail.body.append(plan, assertionUnderstanding);
  assertionUnderstanding.classList.add("assertion-understanding-block");

  const executionDetail = assistantDetailSection("\u6267\u884c\u8fc7\u7a0b", "\u7b49\u5f85\u6267\u884c", "assistantExecutionStatus");
  executionDetail.body.append(trace);

  const assertionDetail = assistantDetailSection("\u65ad\u8a00", "\u7b49\u5f85\u6267\u884c", "assistantAssertionStatus");
  assertionDetail.body.append(assertionResults);

  grid.innerHTML = "";
  if (introCard) grid.append(introCard);
  grid.append(planDetail.details, executionDetail.details, assertionDetail.details);
  if (dslCard) grid.append(dslCard);
  if (knowledgeCard) grid.append(knowledgeCard);
}

function assistantDetailSection(title, statusText, statusId) {
  const details = document.createElement("section");
  details.className = "assistant-card assistant-detail assistant-detail-open";
  const summary = document.createElement("button");
  summary.type = "button";
  summary.className = "assistant-detail-summary";
  const titleNode = document.createElement("span");
  titleNode.textContent = title;
  const status = document.createElement("small");
  status.id = statusId;
  status.textContent = statusText;
  summary.append(titleNode, status);
  const body = document.createElement("div");
  body.className = "assistant-card-body";
  summary.addEventListener("click", () => {
    const collapsed = details.classList.toggle("assistant-detail-collapsed");
    details.classList.toggle("assistant-detail-open", !collapsed);
    body.hidden = collapsed;
  });
  details.append(summary, body);
  return { details, body };
}

function installPixelChatAssistantShell() {
  const title = document.querySelector(".topbar h1");
  if (title) title.textContent = "AI 自动化执行平台";
  const subtitle = document.querySelector(".topbar p");
  if (subtitle) subtitle.textContent = "用自然语言描述任务，平台会理解意图、选择 Page Model 证据、生成 DSL、执行并展示断言结果。";

  const nav = document.querySelector("aside nav");
  if (nav) {
    nav.innerHTML = `
      <button class="nav active" data-view="assistant">AI 助手</button>
      <button class="nav" data-view="cases">用例中心</button>
      <button class="nav" data-view="projectKnowledge">项目知识地图</button>
      <details class="side-advanced">
        <summary>高级功能</summary>
        <button class="nav" data-view="dashboard">总览</button>
        <button class="nav" data-view="tasks">任务</button>
        <button class="nav" data-view="run">执行</button>
        <button class="nav" data-view="bootstrap">首次建模</button>
        <button class="nav" data-view="graph">页面地图</button>
        <button class="nav" data-view="elements">元素库</button>
        <button class="nav" data-view="accounts">账号管理</button>
        <button class="nav" data-view="verifications">验证码监听</button>
        <button class="nav" data-view="environment">环境管理</button>
      </details>`;
  }
  installCaseCenterView();

  document.querySelectorAll(".view").forEach((item) => item.classList.remove("active"));
  $("assistant")?.classList.add("active");

  const assistant = $("assistant");
  if (!assistant) return;
  assistant.innerHTML = `
    <section class="pixel-chat-shell">
      <header class="pixel-chat-header">
        <div>
          <span class="pixel-kicker">PAGE MODEL AUTOMATION</span>
          <h2>AI 助手</h2>
          <p>输入你要执行的操作；如果写了期望结果，平台会把它转换成 DSL 断言并展示断言理解与结果。</p>
        </div>
        <div class="pixel-status-strip">
          <span>demo</span>
          <span>test</span>
          <span id="assistantRuntimeState">idle</span>
        </div>
      </header>

      <div class="assistant-workspace pixel-chat-workspace">
        <div class="assistant-result-grid pixel-chat-stream" aria-label="AI 助手对话流">
          <section class="assistant-card pixel-message pixel-message-ai">
            <div class="pixel-message-meta">AI / 启动</div>
            <div class="assistant-card-body">
              <p class="pixel-message-text">我会按统一链路处理：需求理解 → 证据选择 → DSL → 执行 → 断言结果。没有用户断言时，只执行操作。</p>
            </div>
          </section>
          <section class="assistant-card assistant-json-card pixel-message pixel-message-tech">
            <div class="pixel-message-meta">DSL / 技术明细</div>
            <pre id="assistantPlan">等待生成。</pre>
          </section>
          <section class="assistant-card assistant-json-card pixel-message pixel-message-tech">
            <div class="pixel-message-meta">Evidence / 命中知识</div>
            <div class="table-wrap assistant-knowledge">
              <table>
                <thead><tr><th>标题</th><th>来源</th><th>置信度</th><th>内容</th></tr></thead>
                <tbody id="assistantKnowledgeRows"></tbody>
              </table>
            </div>
          </section>
          <div id="assistantPlanOverview" class="assistant-card-body">等待生成。</div>
          <div id="assistantAssertionUnderstanding" class="assistant-card-body">等待生成计划。</div>
          <div id="assistantAssertionResults" class="assistant-card-body">等待执行。</div>
          <div class="assistant-trace" id="assistantTrace"></div>
        </div>

        <div class="assistant-compose-card pixel-composer">
          <label class="assistant-prompt-label">需求描述
            <textarea id="assistantMessage" rows="4" placeholder="例如：登录 demo test 环境，进入理财流水页面，交易类型下拉框选择“申购”进行查询，期望列表中仅返回类型为“申购”的数据"></textarea>
          </label>
          <div class="assistant-examples" aria-label="示例需求">
            <button type="button" class="prompt-chip" data-prompt="登录 demo test 环境，进入现货流水页面，类型选择红包发放进行搜索，期望列表中仅返回类型为红包发放的数据">现货流水筛选</button>
            <button type="button" class="prompt-chip" data-prompt="登录 demo test 环境，进入理财流水页面，交易类型下拉框选择“申购”进行查询，期望列表中仅返回类型为“申购”的数据">理财流水筛选</button>
            <button type="button" class="prompt-chip" data-prompt="登录 demo test 环境，进入现货流水页面，币种下拉框选择“ETH”进行查询，期望列表返回空">空列表断言</button>
          </div>
          <div class="button-row assistant-actions">
            <button id="assistantSend" type="button">生成计划</button>
            <button id="assistantExecute" type="button" class="secondary-button">执行当前计划</button>
          </div>
          <div class="assistant-status" id="assistantStatus">等待需求。</div>
        </div>
      </div>
    </section>`;

  upgradeAssistantResultLayout();

  document.querySelectorAll(".prompt-chip").forEach((button) => {
    button.addEventListener("click", () => {
      const prompt = button.getAttribute("data-prompt") ?? "";
      if ($("assistantMessage")) $("assistantMessage").value = prompt;
    });
  });
}

function installConversationAssistantShell() {
  const title = document.querySelector(".topbar h1");
  if (title) title.textContent = "AI 自动化执行平台";
  const subtitle = document.querySelector(".topbar p");
  if (subtitle) subtitle.textContent = "输入自然语言需求，平台完成需求理解、证据选择、DSL 生成、执行和断言反馈。";

  const nav = document.querySelector("aside nav");
  if (nav) {
    nav.innerHTML = `
      <button class="nav active" data-view="assistant">AI 助手</button>
      <button class="nav" data-view="cases">用例中心</button>
      <button class="nav" data-view="projectKnowledge">项目知识地图</button>
      <details class="side-advanced">
        <summary>高级功能</summary>
        <button class="nav" data-view="dashboard">总览</button>
        <button class="nav" data-view="tasks">任务</button>
        <button class="nav" data-view="run">执行</button>
        <button class="nav" data-view="bootstrap">首次建模</button>
        <button class="nav" data-view="graph">页面地图</button>
        <button class="nav" data-view="elements">元素库</button>
        <button class="nav" data-view="accounts">账号管理</button>
        <button class="nav" data-view="verifications">验证码监听</button>
        <button class="nav" data-view="environment">环境管理</button>
      </details>`;
  }
  installCaseCenterView();

  document.querySelectorAll(".view").forEach((item) => item.classList.remove("active"));
  $("assistant")?.classList.add("active");

  const assistant = $("assistant");
  if (!assistant) return;
  assistant.innerHTML = `
    <section class="conversation-shell">
      <header class="conversation-header">
        <div>
          <span class="conversation-kicker">AI AUTOMATION WORKBENCH</span>
          <h2>AI 助手</h2>
        </div>
        <div class="conversation-runtime">
          <span>demo</span>
          <span>test</span>
          <span id="assistantRuntimeState">idle</span>
        </div>
      </header>

      <div id="assistantConversation" class="conversation-stream" aria-live="polite">
        <div id="assistantEmptyState" class="conversation-empty">
          <strong>等待需求</strong>
          <span>发送需求后，我会把理解、计划、执行过程和断言结果逐步回填到这里。</span>
        </div>
      </div>

      <section class="conversation-composer">
        <textarea id="assistantMessage" rows="3" placeholder="请输入需求，例如：登录 demo test 环境，进入理财流水页面，交易类型下拉框选择“申购”进行查询，期望列表中仅返回类型为“申购”的数据"></textarea>
        <div class="conversation-examples">
          <button type="button" class="prompt-chip" data-prompt="登录 demo test 环境，进入现货流水页面，类型选择红包发放进行搜索，期望列表中仅返回类型为红包发放的数据">现货流水筛选</button>
          <button type="button" class="prompt-chip" data-prompt="登录 demo test 环境，进入理财流水页面，交易类型下拉框选择“申购”进行查询，期望列表中仅返回类型为“申购”的数据">理财流水筛选</button>
          <button type="button" class="prompt-chip" data-prompt="登录 demo test 环境，进入现货流水页面，币种下拉框选择“ETH”进行查询，期望列表返回空">空列表断言</button>
        </div>
        <div class="conversation-actions">
          <button id="assistantSend" type="button">生成计划</button>
          <button id="assistantExecute" type="button" class="secondary-button">执行当前计划</button>
        </div>
        <div class="assistant-status" id="assistantStatus">等待需求。</div>
      </section>

      <section class="assistant-hidden-state" aria-hidden="true">
        <div id="assistantPlanOverview"></div>
        <div id="assistantAssertionUnderstanding"></div>
        <div id="assistantAssertionResults"></div>
        <div id="assistantTrace"></div>
        <pre id="assistantPlan"></pre>
        <table><tbody id="assistantKnowledgeRows"></tbody></table>
      </section>
    </section>`;

  document.querySelectorAll(".prompt-chip").forEach((button) => {
    button.addEventListener("click", () => {
      const prompt = button.getAttribute("data-prompt") ?? "";
      if ($("assistantMessage")) $("assistantMessage").value = prompt;
    });
  });
}

function resetAssistantConversation() {
  const stream = $("assistantConversation");
  if (!stream) return;
  stream.innerHTML = `<div id="assistantEmptyState" class="workbench-empty"><strong>等待需求</strong><p>发送需求后，理解、计划、执行过程和断言结果会逐条显示在这里。</p></div>`;
}

function appendAssistantConversationMessage(role, title, html, options = {}) {
  const stream = $("assistantConversation");
  if (!stream) return null;
  $("assistantEmptyState")?.remove();
  const article = document.createElement("article");
  article.className = `conversation-message conversation-message-entry conversation-message-${role}${options.status ? ` ${options.status}` : ""}`;
  if (options.id) article.id = options.id;
  article.innerHTML = `
    <div class="conversation-bubble">
      <header><strong>${escapeHtml(title)}</strong>${options.badge ? `<span>${escapeHtml(options.badge)}</span>` : ""}</header>
      <div class="conversation-message-body">${html}</div>
    </div>`;
  stream.append(article);
  stream.scrollTop = stream.scrollHeight;
  return article;
}

function updateAssistantConversationMessage(id, title, html, options = {}) {
  const article = $(id);
  if (!article) return appendAssistantConversationMessage("ai", title, html, { ...options, id });
  article.className = `conversation-message conversation-message-entry conversation-message-ai${options.status ? ` ${options.status}` : ""}`;
  const titleNode = article.querySelector("header strong");
  const badgeNode = article.querySelector("header span");
  const body = article.querySelector(".conversation-message-body");
  if (titleNode) titleNode.textContent = title;
  if (badgeNode && options.badge) badgeNode.textContent = options.badge;
  if (body) body.innerHTML = html;
  article.scrollIntoView({ block: "start" });
  return article;
}

function conversationDetails(title, html, open = false) {
  return `<details class="conversation-details"${open ? " open" : ""}><summary>${escapeHtml(title)}</summary><div>${html}</div></details>`;
}

function installCaseCenterView() {
  if ($("cases")) {
    installProjectKnowledgeMapView();
    return;
  }
  const main = document.querySelector("main");
  if (!main) return;
  main.insertAdjacentHTML(
    "beforeend",
    `
      <section id="cases" class="view case-center-view">
        <section class="case-toolbar workspace-panel">
          <div>
            <h2>用例中心</h2>
          </div>
          <label class="observation-toggle page-head-observation-toggle" title="开启后本次用例执行生成执行观测包。">
            <input id="caseObservationMode" type="checkbox" />
            <span>执行观测</span>
          </label>
        </section>
        <section class="case-layout">
          <section class="workspace-panel case-list-panel">
            <div class="case-list-head">
              <div class="case-context-controls">
                <label>项目<select id="caseProject"></select></label>
                <label>环境<select id="caseEnv"></select></label>
              </div>
              <div class="case-batch-toolbar">
                <label class="check compact-check"><input id="selectAllCases" type="checkbox" /> 全选</label>
                <button id="generateCaseDsl" type="button" class="secondary-button" disabled>生成 DSL</button>
                <button id="pauseCaseDslGeneration" type="button" class="secondary-button case-pause-button" disabled>暂停生成</button>
                <button id="executeCases" type="button" class="secondary-button" disabled>批量执行</button>
              </div>
            </div>
            <div id="caseBatchStatus" class="case-batch-status hidden"></div>
            <div class="case-collection-list" id="caseRows"></div>
            <div class="case-list-footer">
              <span id="caseStatusText" class="case-status-text muted">共 0 条 · 第 0/0 页</span>
              <div class="case-pagination">
                <button id="casePrevPage" type="button" class="secondary-button" disabled>上一页</button>
                <button id="caseNextPage" type="button" class="secondary-button" disabled>下一页</button>
              </div>
            </div>
          </section>
          <section class="workspace-panel case-detail-panel inspector-panel">
            <div id="caseDetail">请选择一条用例。</div>
          </section>
        </section>
      </section>`
  );
  installProjectKnowledgeMapView();
  bindCaseContextSelectors();
  $("pauseCaseDslGeneration")?.addEventListener("click", cancelCaseDslGeneration);
  $("refreshCases")?.addEventListener("click", loadCases);
  $("selectAllCases")?.addEventListener("change", () => {
    document.querySelectorAll(".case-select").forEach((item) => {
      item.checked = $("selectAllCases").checked;
    });
    updateCaseActionState();
  });
  $("casePrevPage")?.addEventListener("click", () => {
    currentCasePage = Math.max(1, currentCasePage - 1);
    renderCases(currentCaseAssets);
  });
  $("caseNextPage")?.addEventListener("click", () => {
    const totalPages = Math.max(1, Math.ceil(currentCaseAssets.length / CASE_PAGE_SIZE));
    currentCasePage = Math.min(totalPages, currentCasePage + 1);
    renderCases(currentCaseAssets);
  });
}

function bindCaseContextSelectors() {
  $("caseProject")?.addEventListener("change", () => {
    if ($("project")) $("project").value = $("caseProject").value;
    syncEnvOptions();
    syncWorkbenchCommandContext();
    loadCases();
  });
  $("caseEnv")?.addEventListener("change", () => {
    if ($("env")) $("env").value = $("caseEnv").value;
    syncWorkbenchCommandContext();
    loadCases();
  });
  syncCaseContextSelectors();
}

function syncCaseContextSelectors() {
  if ($("caseProject") && $("project")) {
    $("caseProject").innerHTML = $("project").innerHTML;
    $("caseProject").value = $("project").value;
  }
  if ($("caseEnv") && $("env")) {
    $("caseEnv").innerHTML = $("env").innerHTML;
    $("caseEnv").value = $("env").value;
  }
}

function installProjectKnowledgeMapView() {
  if ($("projectKnowledge")) return;
  const main = document.querySelector("main");
  if (!main) return;
  main.insertAdjacentHTML(
    "beforeend",
    `
      <section id="projectKnowledge" class="view project-knowledge-view">
        <section class="workspace-panel project-knowledge-panel">
          <div class="knowledge-map-head">
            <div>
              <h2>项目知识地图</h2>
              <p class="muted">模块树、页面能力、元素、动作和断言证据的项目级地图。</p>
            </div>
            <button id="refreshProjectKnowledgeMap" type="button" class="secondary-button">刷新地图</button>
          </div>
          <div class="knowledge-map-summary" id="projectKnowledgeSummary"></div>
          <section class="knowledge-map-layout">
            <div class="knowledge-tree" id="projectKnowledgeTree">等待加载。</div>
            <div class="knowledge-detail" id="projectKnowledgeDetail">请选择一个节点。</div>
          </section>
        </section>
      </section>`
  );
  $("refreshProjectKnowledgeMap")?.addEventListener("click", loadProjectKnowledgeMap);
}

function installProjectCapabilitiesView() {
  if ($("projectCapabilities")) return;
  const main = document.querySelector("main");
  if (!main) return;
  main.insertAdjacentHTML(
    "beforeend",
    `
      <section id="projectCapabilities" class="view project-capabilities-view">
        <section class="workspace-panel project-capabilities-panel">
          <div class="knowledge-map-head">
            <div>
              <h2>项目能力</h2>
              <p class="muted">按项目查看已具备的建模、账号、验证码和资产能力。</p>
            </div>
            <button id="refreshProjectCapabilities" type="button" class="secondary-button">刷新能力</button>
          </div>
          <div class="knowledge-map-summary" id="projectCapabilitiesSummary"></div>
          <div class="project-capabilities-grid" id="projectCapabilitiesList">等待加载。</div>
        </section>
      </section>`
  );
  $("refreshProjectCapabilities")?.addEventListener("click", loadProjectCapabilities);
}

function installDatabaseWorkbenchView() {
  if ($("database")) return;
  const main = document.querySelector("main");
  if (!main) return;
  main.insertAdjacentHTML(
    "beforeend",
    `
      <section id="database" class="view database-workbench-view">
        <section class="workspace-panel database-workbench-panel">
          <div class="database-head">
            <div>
              <h2>数据库</h2>
            </div>
            <button id="refreshDatabaseSchema" type="button" class="secondary-button">刷新结构</button>
          </div>
          <div class="database-summary" id="databaseSummary"></div>
          <section class="database-model-summary" id="databaseModelSummary">等待加载数据库模型。</section>
          <section class="database-layout">
            <aside class="database-tree-panel">
              <div class="panel-header"><strong>数据源 / 表</strong><span id="databaseTreeStatus">等待加载。</span></div>
              <div id="databaseTree" class="database-tree">等待加载。</div>
            </aside>
            <section class="database-detail-panel">
              <div id="databaseTableDetail" class="database-table-detail">请选择一张表。</div>
              <section class="database-sql-panel">
                <div class="panel-header">
                  <strong>SQL Assistant</strong>
                  <span>DeepSeek 生成，只读确认执行</span>
                </div>
                <div class="database-sql-controls">
                  <label>数据源<select id="databaseSqlSource"></select></label>
                  <label class="wide">自然语言<textarea id="databaseSqlRequest" rows="3" placeholder="例如：查询最近 5 条执行记录"></textarea></label>
                  <div class="button-row">
                    <button id="generateDatabaseSql" type="button">生成 SQL</button>
                    <button id="executeDatabaseSql" type="button" class="secondary-button">确认执行</button>
                  </div>
                  <label class="wide">SQL<textarea id="databaseSqlText" rows="5" spellcheck="false"></textarea></label>
                </div>
                <div id="databaseSqlStatus" class="database-sql-status muted">只允许 SELECT / PRAGMA；写入类 SQL 会被阻止。</div>
                <div id="databaseSqlResult" class="database-result-wrap"></div>
              </section>
            </section>
          </section>
        </section>
      </section>`
  );
  $("refreshDatabaseSchema")?.addEventListener("click", () => loadDatabaseWorkbenchSchema(true));
  $("generateDatabaseSql")?.addEventListener("click", generateDatabaseSql);
  $("executeDatabaseSql")?.addEventListener("click", executeDatabaseSql);
}

function installAccountFactoryView() {
  if ($("accountFactory")) return;
  const main = document.querySelector("main");
  if (!main) return;
  main.insertAdjacentHTML(
    "beforeend",
    `
      <section id="accountFactory" class="view account-factory-view">
        <section class="workspace-panel account-factory-panel">
          <div class="account-factory-head">
            <div>
              <h2>账号工厂</h2>
              <span>按项目 adapter 准备测试账号和前置条件。</span>
            </div>
            <div class="button-row compact">
              <button id="accountFactoryPrecheck" type="button" class="secondary-button">预检条件</button>
              <button id="accountFactoryCreate" type="button">创建账号</button>
            </div>
          </div>
          <section class="account-factory-layout">
            <aside class="account-factory-config">
              <div class="panel-header"><strong>创建配置</strong><span id="accountFactoryStatus">等待配置。</span></div>
              <div class="account-factory-form">
                <label>项目<select id="accountFactoryProject"></select></label>
                <label>环境<select id="accountFactoryEnv"></select></label>
                <div class="factory-rule-card">
                  <small>命名规则</small>
                  <strong id="accountFactoryPreview">userTestA001@example.com</strong>
                  <span>固定格式：userTestA{三位序号}@example.com；提交时自动跳过已存在账号。</span>
                </div>
                <label>起始序号<input id="accountFactorySequence" type="number" min="1" max="999" value="1" /></label>
                <label>固定前缀<input id="accountFactoryPrefix" value="userTestA" /></label>
                <label>固定后缀<input id="accountFactorySuffix" value="@example.com" readonly /></label>
                <label>默认密码<input id="accountFactoryPassword" type="password" placeholder="留空使用平台默认密码" /></label>
              </div>
            </aside>
            <section class="account-factory-main">
              <div class="factory-option-grid">
                <label class="factory-option"><input id="factoryNeedKyc" type="checkbox" /><span><strong>完成 KYC</strong><small>由项目 adapter 补齐身份认证状态。</small></span></label>
                <label class="factory-option"><input id="factoryNeedGoogle" type="checkbox" /><span><strong>绑定 Google</strong><small>登记到 KeePassXC，供 TOTP provider 使用。</small></span></label>
                <label class="factory-option"><input id="factoryNeedAssets" type="checkbox" /><span><strong>充值 / 赠币</strong><small>按资产账户和币种补齐测试资金。</small></span></label>
                <label class="factory-option"><input id="factoryRefreshProfile" type="checkbox" checked /><span><strong>刷新账号画像</strong><small>创建完成后重新读取数据库画像。</small></span></label>
              </div>
              <div class="factory-assets-card">
                <div class="panel-header"><strong>资产要求</strong><span>启用充值 / 赠币后生效</span></div>
                <div class="factory-assets-grid">
                  <label>账户类型<select id="factoryAssetAccountType"><option value="spot">现货</option><option value="earn">理财</option><option value="contract">合约</option></select></label>
                  <label>币种<input id="factoryAssetSymbol" value="USDT" /></label>
                  <label>数量<input id="factoryAssetAmount" value="100" /></label>
                </div>
              </div>
              <div class="factory-readiness-card">
                <div class="panel-header"><strong>Adapter 准备度</strong><span id="accountFactoryReadinessSummary">等待预检。</span></div>
                <div id="accountFactoryReadiness" class="factory-readiness-list"></div>
              </div>
              <div class="factory-result-card">
                <div class="panel-header"><strong>执行结果</strong><span>阻断也会保留诊断信息。</span></div>
                <div id="accountFactoryResult" class="factory-result-empty">尚未提交账号准备请求。</div>
              </div>
            </section>
          </section>
        </section>
      </section>`
  );
  $("accountFactoryPrecheck")?.addEventListener("click", loadAccountFactoryCapabilities);
  $("accountFactoryCreate")?.addEventListener("click", submitAccountFactoryProvision);
  $("accountFactoryProject")?.addEventListener("change", () => {
    syncAccountFactoryEnvOptions();
    loadAccountFactoryCapabilities();
  });
  $("accountFactoryEnv")?.addEventListener("change", loadAccountFactoryCapabilities);
  ["accountFactorySequence", "accountFactoryPrefix", "accountFactorySuffix"].forEach((id) => {
    $(id)?.addEventListener("input", updateAccountFactoryPreview);
  });
  ["factoryNeedKyc", "factoryNeedGoogle", "factoryNeedAssets", "factoryRefreshProfile"].forEach((id) => {
    $(id)?.addEventListener("change", updateAccountFactoryPreview);
  });
}

async function loadDatabaseWorkbenchSchema(force = false) {
  if (!$("databaseTree")) return;
  const project = encodeURIComponent($("project")?.value || "demo");
  const env = encodeURIComponent($("env")?.value || "test");
  $("databaseTree").textContent = force ? "正在强制刷新数据库结构..." : "正在读取数据库结构...";
  $("databaseTreeStatus").textContent = force ? "刷新中" : "加载中";
  try {
    const [payload, modelPayload] = await Promise.all([
      fetch(`/api/database/schema?project=${project}&env=${env}${force ? "&force=true" : ""}`).then((item) => item.json()),
      fetch(`/api/database/models?project=${project}`).then((item) => item.json()).catch((error) => ({ ok: false, error: error?.message ?? String(error) }))
    ]);
    currentDatabaseSchema = payload;
    currentDatabaseModel = modelPayload;
    renderDatabaseWorkbenchSchema(payload);
    renderDatabaseModelSummary(modelPayload);
  } catch (error) {
    $("databaseTree").innerHTML = `<div class="empty-card">数据库结构加载失败：${escapeHtml(error?.message ?? String(error))}</div>`;
    $("databaseTreeStatus").textContent = "失败";
    renderDatabaseModelSummary({ ok: false, error: error?.message ?? String(error) });
  }
}

function syncAccountFactoryProjectOptions() {
  if (!$("accountFactoryProject")) return;
  const previous = $("accountFactoryProject").value || $("project")?.value || "demo";
  $("accountFactoryProject").innerHTML = projectCatalog
    .map((item) => `<option value="${escapeHtml(item.key)}">${escapeHtml(item.name)}</option>`)
    .join("");
  $("accountFactoryProject").value = projectCatalog.some((item) => item.key === previous)
    ? previous
    : projectCatalog.find((item) => item.key === "demo")?.key ?? projectCatalog[0]?.key ?? "demo";
  syncAccountFactoryEnvOptions();
}

function syncAccountFactoryEnvOptions() {
  if (!$("accountFactoryEnv")) return;
  const projectKey = $("accountFactoryProject")?.value || $("project")?.value || "demo";
  const project = projectCatalog.find((item) => item.key === projectKey) ?? currentProject();
  const previous = $("accountFactoryEnv").value || $("env")?.value || project?.defaultEnv || "test";
  const envs = project?.envs ?? [];
  $("accountFactoryEnv").innerHTML = envs
    .map((item) => `<option value="${escapeHtml(item.key)}">${escapeHtml(item.name)}</option>`)
    .join("");
  $("accountFactoryEnv").value = envs.some((item) => item.key === previous) ? previous : project?.defaultEnv ?? envs[0]?.key ?? "test";
  updateAccountFactoryPreview();
}

function accountFactoryUsernamePreview() {
  const prefix = String($("accountFactoryPrefix")?.value || "userTestA").trim() || "userTestA";
  const suffix = String($("accountFactorySuffix")?.value || "@example.com").trim() || "@example.com";
  const sequence = Math.max(1, Math.min(999, Number($("accountFactorySequence")?.value || 1)));
  return `${prefix}${String(sequence).padStart(3, "0")}${suffix}`;
}

function updateAccountFactoryPreview() {
  if ($("accountFactoryPreview")) $("accountFactoryPreview").textContent = accountFactoryUsernamePreview();
}

function accountFactoryRequirements() {
  const requirements = [];
  if ($("factoryNeedKyc")?.checked) requirements.push({ type: "kyc", targetState: "completed" });
  if ($("factoryNeedGoogle")?.checked) requirements.push({ type: "mfa", provider: "google_totp", targetState: "bound" });
  if ($("factoryNeedAssets")?.checked) {
    requirements.push({
      type: "asset_balance",
      accountType: $("factoryAssetAccountType")?.value || "spot",
      asset: String($("factoryAssetSymbol")?.value || "USDT").trim().toUpperCase(),
      minimumAmount: String($("factoryAssetAmount")?.value || "100").trim()
    });
  }
  if ($("factoryRefreshProfile")?.checked) requirements.push({ type: "account_profile_refresh", targetState: "refreshed" });
  return requirements;
}

function accountFactoryRequestPayload() {
  return {
    project: $("accountFactoryProject")?.value || $("project")?.value || "demo",
    env: $("accountFactoryEnv")?.value || $("env")?.value || "test",
    reason: "account_factory_web_request",
    username: accountFactoryUsernamePreview(),
    password: $("accountFactoryPassword")?.value || "",
    namingRule: {
      schemaVersion: "account-naming-rule.v1",
      pattern: "userTestA{seq:000}@example.com",
      prefix: $("accountFactoryPrefix")?.value || "userTestA",
      suffix: $("accountFactorySuffix")?.value || "@example.com",
      sequence: Number($("accountFactorySequence")?.value || 1),
      fixedSuffix: true
    },
    autoSequence: true,
    requirements: accountFactoryRequirements()
  };
}

async function loadAccountFactoryCapabilities() {
  if (!$("accountFactoryReadiness")) return;
  if (!projectCatalog.length) await loadProjects();
  syncAccountFactoryProjectOptions();
  const project = encodeURIComponent($("accountFactoryProject")?.value || "demo");
  const env = encodeURIComponent($("accountFactoryEnv")?.value || "test");
  $("accountFactoryStatus").textContent = "正在预检。";
  $("accountFactoryReadiness").innerHTML = `<div class="empty-card">正在读取 adapter 准备度。</div>`;
  const payload = await fetch(`/api/account-factory/capabilities?project=${project}&env=${env}`).then((item) => item.json());
  renderAccountFactoryCapabilities(payload);
}

function renderAccountFactoryCapabilities(payload) {
  const capabilities = Array.isArray(payload?.capabilities) ? payload.capabilities : [];
  if (payload?.sequenceAllocation?.username) {
    if ($("accountFactorySequence")) $("accountFactorySequence").value = String(payload.sequenceAllocation.sequence || $("accountFactorySequence").value || 1);
    if ($("accountFactoryPreview")) $("accountFactoryPreview").textContent = payload.sequenceAllocation.username;
  }
  const ok = payload?.status === "ready";
  $("accountFactoryStatus").textContent = ok ? "可创建。" : "存在阻断。";
  $("accountFactoryReadinessSummary").innerHTML = ok
    ? `<span class="status-text-passed">adapter 已就绪</span>`
    : `<span class="status-text-failed">${escapeHtml(payload?.status ?? "blocked")}</span>`;
  $("accountFactoryReadiness").innerHTML = capabilities.length
    ? capabilities.map((item) => `
      <div class="factory-readiness-item ${escapeHtml(item.status ?? "blocked")}">
        <span class="status-tag ${accountFactoryStatusClass(item.status)}">${escapeHtml(accountFactoryStatusText(item.status))}</span>
        <div>
          <strong>${escapeHtml(item.name ?? item.capabilityId ?? "-")}</strong>
          <small>${escapeHtml(item.reason ?? "")}</small>
        </div>
      </div>`).join("")
    : `<div class="empty-card">暂无 adapter 能力声明。</div>`;
  if (!payload?.sequenceAllocation?.username) updateAccountFactoryPreview();
}

function accountFactoryStatusClass(status) {
  if (status === "ready") return "status-passed";
  if (status === "warning") return "knowledge-partial";
  if (status === "missing" || status === "blocked") return "status-failed";
  return "status-idle";
}

function accountFactoryStatusText(status) {
  return {
    ready: "可用",
    warning: "待确认",
    missing: "缺失",
    blocked: "阻断"
  }[status] ?? status ?? "未知";
}

async function submitAccountFactoryProvision() {
  if (!$("accountFactoryResult")) return;
  const payload = accountFactoryRequestPayload();
  $("accountFactoryStatus").textContent = "正在提交。";
  $("accountFactoryResult").innerHTML = `<div class="empty-card">正在提交账号准备请求。</div>`;
  const result = await fetch("/api/account-factory/provision", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  }).then((item) => item.json());
  renderAccountFactoryResult(result);
}

function renderAccountFactoryResult(result) {
  $("accountFactoryStatus").textContent = result?.ok ? "完成。" : "阻断。";
  const missing = result?.diagnostics?.missingAdapters ?? [];
  const nextActions = result?.diagnostics?.nextActions ?? [];
  const steps = Array.isArray(result?.steps) ? result.steps : [];
  $("accountFactoryResult").innerHTML = `
    <div class="factory-result-head">
      <span class="status-tag ${result?.ok ? "status-passed" : "status-failed"}">${escapeHtml(result?.status ?? (result?.ok ? "ok" : "failed"))}</span>
      <strong>${escapeHtml(result?.username ?? result?.requestedUsername ?? accountFactoryUsernamePreview())}</strong>
    </div>
    <div class="factory-result-grid">
      <div><small>项目</small><span>${escapeHtml(result?.project ?? "-")}</span></div>
      <div><small>环境</small><span>${escapeHtml(result?.env ?? "-")}</span></div>
      <div><small>阶段</small><span>${escapeHtml(result?.diagnostics?.stage ?? "-")}</span></div>
      <div><small>请求项</small><span>${escapeHtml(result?.diagnostics?.requirementCount ?? 0)}</span></div>
    </div>
    ${steps.length ? `<div class="factory-step-list">${steps.map((step) => `
      <div class="factory-step-item ${escapeHtml(step.status ?? "idle")}">
        <span class="status-tag ${accountFactoryStepStatusClass(step.status)}">${escapeHtml(accountFactoryStepStatusText(step.status))}</span>
        <div>
          <strong>${escapeHtml(step.label ?? step.stepId ?? "-")}</strong>
          <small>${escapeHtml(step.message ?? "")}</small>
        </div>
      </div>`).join("")}</div>` : ""}
    ${result?.account ? `<details class="conversation-details" open><summary>账号已写入</summary>
      <div class="factory-result-grid">
        <div><small>账号</small><span>${escapeHtml(result.account.username ?? "-")}</span></div>
        <div><small>账号 ID</small><span>${escapeHtml(result.account.id ?? "-")}</span></div>
        <div><small>项目</small><span>${escapeHtml(result.account.project ?? "-")}</span></div>
        <div><small>环境</small><span>${escapeHtml(result.account.env ?? "-")}</span></div>
      </div>
    </details>` : ""}
    ${result?.diagnostics?.sequenceAllocation ? `<details class="conversation-details" open><summary>序号分配</summary><pre>${escapeHtml(JSON.stringify(result.diagnostics.sequenceAllocation, null, 2))}</pre></details>` : ""}
    ${missing.length ? `<details class="conversation-details" open><summary>缺失 adapter</summary>${renderPlainList(missing)}</details>` : ""}
    ${nextActions.length ? `<details class="conversation-details" open><summary>下一步</summary>${renderPlainList(nextActions)}</details>` : ""}
    <details class="conversation-details"><summary>原始诊断</summary><pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre></details>`;
}

function accountFactoryStepStatusClass(status) {
  if (status === "passed") return "status-passed";
  if (status === "failed") return "status-failed";
  if (status === "skipped") return "knowledge-partial";
  if (status === "blocked") return "status-failed";
  return "status-idle";
}

function accountFactoryStepStatusText(status) {
  return {
    passed: "通过",
    failed: "失败",
    skipped: "跳过",
    blocked: "阻断"
  }[status] ?? status ?? "未知";
}

function renderDatabaseModelSummary(payload) {
  const target = $("databaseModelSummary");
  if (!target) return;
  const model = payload?.model;
  const entities = Array.isArray(model?.entityModels) ? model.entityModels : [];
  if (!payload?.ok || !model) {
    target.innerHTML = `<div class="database-model-empty">当前项目暂无已验证数据库模型。数据库结构可以查看，但不能直接写入账号画像。</div>`;
    return;
  }
  target.innerHTML = `
    <div class="database-model-head">
      <div>
        <strong>已验证数据库模型</strong>
        <span>${escapeHtml(model.project ?? "-")} / ${escapeHtml(model.env ?? "-")} / ${escapeHtml(model.sourceId ?? "-")}</span>
      </div>
      <span class="status-tag status-passed">${escapeHtml(model.status ?? "verified")}</span>
    </div>
    <div class="database-model-grid">
      ${entities.map((entity) => {
        const dimensions = Object.keys(entity.dimensions ?? {});
        return `<article class="database-model-card">
          <div><strong>${escapeHtml(entity.entityId ?? "-")}</strong><span>${escapeHtml(entity.entityType ?? "-")}</span></div>
          <p>${escapeHtml(entity.primaryTable ?? "-")}</p>
          ${Array.isArray(entity.joinPath) && entity.joinPath.length ? `<small>${escapeHtml(entity.joinPath.join(" / "))}</small>` : ""}
          <div class="database-model-dimensions">${dimensions.slice(0, 8).map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>
        </article>`;
      }).join("")}
    </div>
    ${Array.isArray(model.limitations) && model.limitations.length ? `<details class="conversation-details"><summary>模型边界</summary>${renderPlainList(model.limitations)}</details>` : ""}`;
}

function renderDatabaseWorkbenchSchema(payload) {
  const sources = Array.isArray(payload?.sources) ? payload.sources : [];
  const availableSources = sources.filter((source) => source.status === "available");
  const preferredProjectSource = availableSources.find((source) => String(source.sourceId).startsWith("project_"));
  if (!availableSources.some((source) => source.sourceId === currentDatabaseSourceId)) {
    currentDatabaseSourceId = preferredProjectSource?.sourceId ?? availableSources[0]?.sourceId ?? sources[0]?.sourceId ?? "workbench_sqlite";
    currentDatabaseTableName = "";
  } else if (currentDatabaseSourceId === "workbench_sqlite" && preferredProjectSource) {
    currentDatabaseSourceId = preferredProjectSource.sourceId;
    currentDatabaseTableName = "";
  }
  const selectedSource = sources.find((source) => source.sourceId === currentDatabaseSourceId) ?? sources[0];
  const tables = Array.isArray(selectedSource?.tables) ? selectedSource.tables : [];
  if (!tables.some((table) => table.tableName === currentDatabaseTableName)) {
    currentDatabaseTableName = tables[0]?.tableName ?? "";
  }
  $("databaseSummary").innerHTML = `
    <span class="info-badge"><small>项目</small>${escapeHtml(payload?.project ?? "-")}</span>
    <span class="info-badge"><small>环境</small>${escapeHtml(payload?.env ?? "-")}</span>
    <span class="info-badge"><small>数据源</small>${escapeHtml(sources.length)}</span>
    <span class="info-badge"><small>用户相关表</small>${escapeHtml(sources.reduce((total, source) => total + (Array.isArray(source.tables) ? source.tables.length : 0), 0))}</span>
    <span class="info-badge"><small>更新时间</small>${escapeHtml(formatDate(payload?.updatedAt))}</span>`;
  $("databaseTreeStatus").textContent = `${sources.length} 个数据源`;
  $("databaseTree").innerHTML = sources.map(renderDatabaseSourceTree).join("") || `<div class="empty-card">暂无数据库源。</div>`;
  document.querySelectorAll("[data-database-source]").forEach((button) => {
    button.addEventListener("click", () => {
      currentDatabaseSourceId = button.getAttribute("data-database-source") || currentDatabaseSourceId;
      currentDatabaseTableName = "";
      renderDatabaseWorkbenchSchema(currentDatabaseSchema);
    });
  });
  document.querySelectorAll("[data-database-table]").forEach((button) => {
    button.addEventListener("click", () => {
      currentDatabaseSourceId = button.getAttribute("data-source-id") || currentDatabaseSourceId;
      currentDatabaseTableName = button.getAttribute("data-database-table") || "";
      renderDatabaseWorkbenchSchema(currentDatabaseSchema);
    });
  });
  if ($("databaseSqlSource")) {
    $("databaseSqlSource").innerHTML = availableSources
      .map((source) => `<option value="${escapeHtml(source.sourceId)}"${source.sourceId === currentDatabaseSourceId ? " selected" : ""}>${escapeHtml(source.displayName ?? source.sourceId)}</option>`)
      .join("");
    $("databaseSqlSource").onchange = () => {
      currentDatabaseSourceId = $("databaseSqlSource").value;
      renderDatabaseWorkbenchSchema(currentDatabaseSchema);
    };
  }
  renderDatabaseTableDetail(selectedSource, tables.find((table) => table.tableName === currentDatabaseTableName));
}

function renderDatabaseSourceTree(source) {
  const tables = Array.isArray(source.tables) ? source.tables : [];
  const active = source.sourceId === currentDatabaseSourceId;
  const statusClass = source.status === "available" ? "status-passed" : source.status === "not_configured" ? "status-idle" : "status-failed";
  return `<section class="database-source-card${active ? " active" : ""}">
    <button type="button" class="database-source-button" data-database-source="${escapeHtml(source.sourceId)}">
      <span><strong>${escapeHtml(source.displayName ?? source.sourceId)}</strong><small>${escapeHtml(source.type ?? "-")}</small></span>
      <span class="status-tag ${statusClass}">${escapeHtml(databaseSourceStatusText(source.status))}</span>
    </button>
    ${source.status === "available" && source.summary ? `<div class="database-source-notes"><p>共 ${escapeHtml(source.summary.totalTables ?? "-")} 张表，筛出 ${escapeHtml(source.summary.userRelatedTables ?? tables.length)} 张用户关系表。</p></div>` : source.notes?.length ? `<div class="database-source-notes">${source.notes.slice(0, 1).map((item) => `<p>${escapeHtml(item)}</p>`).join("")}</div>` : ""}
    <div class="database-table-list">
      ${tables.map((table) => `<button type="button" class="database-table-button${active && table.tableName === currentDatabaseTableName ? " active" : ""}" data-source-id="${escapeHtml(source.sourceId)}" data-database-table="${escapeHtml(table.tableName)}">
        <span>${escapeHtml(table.databaseName ? `${table.databaseName}.${table.tableName}` : table.tableName)}</span>
        <small>${escapeHtml(table.relevance?.category ?? `${table.rowCount ?? "-"} 行`)}</small>
      </button>`).join("") || `<div class="database-empty-inline">暂无可读表。</div>`}
    </div>
  </section>`;
}

function databaseSourceStatusText(status) {
  return {
    available: "可用",
    missing: "缺失",
    unsupported: "暂不支持",
    not_configured: "未配置"
  }[status] || String(status || "-");
}

function renderDatabaseTableDetail(source, table) {
  if (!$("databaseTableDetail")) return;
  if (!source) {
    $("databaseTableDetail").innerHTML = `<div class="workbench-empty"><strong>暂无数据源</strong><p>请先配置项目环境数据库或平台 SQLite。</p></div>`;
    return;
  }
  if (!table) {
    $("databaseTableDetail").innerHTML = `<div class="workbench-empty"><strong>${escapeHtml(source.displayName ?? source.sourceId)}</strong><p>${escapeHtml((source.notes ?? []).join(" ") || "该数据源暂无可读表。")}</p></div>`;
    return;
  }
  const columns = Array.isArray(table.columns) ? table.columns : [];
  const foreignKeys = Array.isArray(table.foreignKeys) ? table.foreignKeys : [];
  const relationshipHints = Array.isArray(table.relationshipHints) ? table.relationshipHints : [];
  const profileDimensions = Array.isArray(table.profileDimensions) ? table.profileDimensions : [];
  const coreColumns = databaseCoreColumns(columns);
  $("databaseTableDetail").innerHTML = `
    <div class="database-table-head">
      <div>
        <h3>${escapeHtml(table.databaseName ? `${table.databaseName}.${table.tableName}` : table.tableName)}</h3>
        <p>${escapeHtml(table.comment ?? "-")}</p>
      </div>
      <span class="status-tag status-idle">${escapeHtml(table.relevance?.category ?? table.tableType ?? "table")}</span>
    </div>
    <div class="assistant-badge-row">
      <span class="info-badge"><small>数据源</small>${escapeHtml(source.displayName ?? source.sourceId)}</span>
      <span class="info-badge"><small>相关性</small>${escapeHtml(table.relevance?.score ?? "-")}</span>
      <span class="info-badge"><small>字段</small>${escapeHtml(columns.length)}</span>
      <span class="info-badge"><small>关系线索</small>${escapeHtml(relationshipHints.length + foreignKeys.length)}</span>
    </div>
    ${table.relevance?.reasons?.length ? `<div class="database-reason-row">${table.relevance.reasons.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>` : ""}
    <section class="database-user-relation-grid">
      <div>
        <h4>可支撑的用户画像</h4>
        ${profileDimensions.length ? renderPlainList(profileDimensions) : `<div class="empty-card">暂未推断出画像维度。</div>`}
      </div>
      <div>
        <h4>用户关系线索</h4>
        ${relationshipHints.length ? renderPlainList(relationshipHints.slice(0, 12).map((hint) => `${hint.type}: ${hint.from ?? ""} ${hint.to ? `-> ${hint.to}` : ""}${hint.note ? `，${hint.note}` : ""}`)) : `<div class="empty-card">未发现明确关系线索。</div>`}
      </div>
    </section>
    <details class="conversation-details" open>
      <summary>核心字段</summary>
      <div class="conversation-table"><table><thead><tr><th>字段</th><th>类型</th><th>空值</th><th>主键</th><th>备注</th></tr></thead><tbody>
        ${coreColumns.map((column) => `<tr><td>${escapeHtml(column.name)}</td><td>${escapeHtml(column.type)}</td><td>${column.nullable ? "是" : "否"}</td><td>${column.primaryKey ? "是" : "否"}</td><td>${escapeHtml(column.comment ?? "-")}</td></tr>`).join("")}
      </tbody></table></div>
    </details>
    <details class="conversation-details">
      <summary>外键关系</summary>
      ${foreignKeys.length ? `<div class="conversation-table"><table><thead><tr><th>字段</th><th>关联表</th><th>关联字段</th></tr></thead><tbody>${foreignKeys.map((fk) => `<tr><td>${escapeHtml(fk.from)}</td><td>${escapeHtml(fk.toTable)}</td><td>${escapeHtml(fk.toColumn)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-card">未发现外键关系。</div>`}
    </details>`;
}

function databaseCoreColumns(columns) {
  const selected = columns.filter((column) => /(id|uid|user|member|account|email|phone|mobile|kyc|verify|auth|google|ga|totp|mfa|asset|coin|currency|symbol|balance|available|frozen|amount|status|state|type|created|updated|time|date)/i.test(String(column.name ?? "")));
  return (selected.length ? selected : columns).filter((column) => !/(password|secret|token|code|key)/i.test(String(column.name ?? ""))).slice(0, 24);
}

async function generateDatabaseSql() {
  const message = $("databaseSqlRequest")?.value?.trim() || "";
  const sourceId = $("databaseSqlSource")?.value || currentDatabaseSourceId;
  if (!message) {
    $("databaseSqlStatus").textContent = "请先输入自然语言查询需求。";
    return;
  }
  $("databaseSqlStatus").textContent = "正在调用 DeepSeek 生成 SQL...";
  $("databaseSqlResult").innerHTML = "";
  const payload = await fetch("/api/database/generate-sql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: $("project")?.value || "demo", env: $("env")?.value || "test", sourceId, message })
  }).then((item) => item.json());
  if (payload.sql && $("databaseSqlText")) $("databaseSqlText").value = payload.sql;
  $("databaseSqlStatus").innerHTML = payload.ok
    ? `SQL 已生成：${escapeHtml(payload.explanation ?? "")}`
    : `<span class="status-text-failed">${escapeHtml(payload.error ?? payload.validation?.reason ?? "SQL 生成失败。")}</span>`;
}

async function executeDatabaseSql() {
  const sql = $("databaseSqlText")?.value?.trim() || "";
  const sourceId = $("databaseSqlSource")?.value || currentDatabaseSourceId;
  if (!sql) {
    $("databaseSqlStatus").textContent = "请先生成或输入 SQL。";
    return;
  }
  if (!window.confirm("确认执行这条只读 SQL？第一版只允许 SELECT / PRAGMA，结果会做敏感字段遮蔽。")) return;
  $("databaseSqlStatus").textContent = "正在执行只读 SQL...";
  const payload = await fetch("/api/database/execute-sql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: $("project")?.value || "demo", env: $("env")?.value || "test", sourceId, sql })
  }).then((item) => item.json());
  renderDatabaseSqlResult(payload);
}

function renderDatabaseSqlResult(result) {
  $("databaseSqlStatus").innerHTML = result.ok
    ? `<span class="status-text-passed">执行成功，返回 ${escapeHtml(result.rowCount ?? 0)} 行。</span>`
    : `<span class="status-text-failed">${escapeHtml(result.error ?? result.validation?.reason ?? "执行失败。")}</span>`;
  const rows = Array.isArray(result.rows) ? result.rows : [];
  $("databaseSqlResult").innerHTML = rows.length ? renderDatabaseResultTable(rows) : `<div class="empty-card">${result.ok ? "SQL 执行成功，无返回行。" : "无结果。"}</div>`;
}

function renderDatabaseResultTable(rows) {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return `<div class="conversation-table"><table><thead><tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead><tbody>
    ${rows.map((row) => `<tr>${columns.map((column) => `<td title="${escapeHtml(row[column] ?? "")}">${escapeHtml(row[column] ?? "")}</td>`).join("")}</tr>`).join("")}
  </tbody></table></div>`;
}

async function postAction(path, payload, outputId) {
  $(outputId).textContent = "任务执行中...";
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  $(outputId).textContent = formatCommandResult(result);
  await refresh();
}

async function toggleWebExplore() {
  if (webExploreRunning) {
    $("exploreConsoleOutput").textContent += "\n\n正在请求停止 Web 探索...";
    const result = await fetch("/api/actions/stop-web-explore", { method: "POST" }).then((item) => item.json());
    $("exploreConsoleOutput").textContent += `\n${result.message || `停止请求已发送，pid=${result.pid ?? ""}`}`;
    return;
  }

  setWebExploreRunning(true);
  $("exploreConsoleOutput").textContent = "Web 探索执行中...";
  try {
    const response = await fetch("/api/actions/explore-web", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project: $("project").value,
        env: $("env").value,
        surface: $("webSurface").value,
        url: $("webUrl").value,
        maxDepth: $("webDepth").value,
        maxPages: $("webPages").value,
        maxButtonClicksPerPage: $("webButtonBudget").value,
        strategy: $("exploreStrategy").value,
        intensity: $("exploreIntensity").value,
        clickButtons: $("clickButtons").checked,
        headed: $("headedBrowser").checked,
        loginRequired: $("loginRequired").checked,
        username: $("exploreUsername").value,
        password: $("explorePassword").value
      })
    });
    const result = await response.json();
    $("exploreConsoleOutput").textContent = formatCommandResult(result);
    await refresh();
  } finally {
    setWebExploreRunning(false);
  }
}

function applyExploreIntensityPreset() {
  const intensity = $("exploreIntensity").value;
  const aiAssisted = $("exploreStrategy").value === "ai-assisted";
  if (intensity === "custom") return;
  if (intensity === "shallow") {
    $("webDepth").value = aiAssisted ? "2" : "1";
    $("webPages").value = aiAssisted ? "25" : "15";
    $("webButtonBudget").value = aiAssisted ? "6" : "3";
    $("clickButtons").checked = aiAssisted;
    return;
  }
  if (intensity === "deep") {
    $("webDepth").value = aiAssisted ? "4" : "3";
    $("webPages").value = aiAssisted ? "80" : "50";
    $("webButtonBudget").value = aiAssisted ? "12" : "8";
    $("clickButtons").checked = true;
  }
}

function markExploreCustom() {
  $("exploreIntensity").value = "custom";
}

function setWebExploreRunning(running) {
  webExploreRunning = running;
  $("exploreWeb").textContent = running ? "停止 Web 探索" : "开始 Web 探索";
  $("exploreWeb").classList.toggle("danger-button", running);
}

async function sendAssistantMessageLegacy() {
  const message = $("assistantMessage").value.trim();
  if (!message) {
    $("assistantStatus").textContent = "请先输入需求。";
    return;
  }

  $("assistantPlan").textContent = "正在生成...";
  $("assistantAssertionUnderstanding").textContent = "正在解析断言...";
  $("assistantAssertionResults").textContent = "等待执行...";
  $("assistantKnowledgeRows").innerHTML = "";
  const stopProgress = startAssistantProgress();
  try {
    const response = await fetch("/api/assistant/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project: $("project").value,
        env: $("env").value,
        message
      })
    });
    const result = await response.json();
    stopProgress();
    if (result.error) {
      $("assistantStatus").textContent = result.error;
      $("assistantPlan").textContent = result.error;
      return;
    }
    $("assistantStatus").textContent = `已生成计划：${result.usedModel}`;
    renderAssistantTrace(result.trace ?? []);
    currentAssistantPlan = result.plan ?? null;
    $("assistantAssertionUnderstanding").textContent = formatPlanAssertions(planAssertionsFrom(result.plan));
    $("assistantAssertionResults").textContent = "等待执行...";
    $("assistantPlan").textContent = JSON.stringify(result.plan ?? {}, null, 2);
    renderAssistantKnowledge(result.knowledgeHits ?? []);
  } catch (error) {
    stopProgress();
    const message = error instanceof Error ? error.message : String(error);
    $("assistantStatus").textContent = message;
    $("assistantPlan").textContent = message;
  }
}

async function executeAssistantPlanLegacy(confirmWrite = false) {
  if (!currentAssistantPlan) {
    $("assistantStatus").textContent = "请先生成执行计划。";
    return;
  }
  if (currentAssistantPlan.requiresConfirmation && !confirmWrite) {
    $("confirmPlanText").textContent = `当前计划包含写操作或不确定前置条件，需要确认后执行。任务：${currentAssistantPlan.intent ?? ""}`;
    $("confirmPlanModal").classList.remove("hidden");
    return;
  }
  $("assistantStatus").textContent = "正在执行当前计划...";
  $("assistantExecute").disabled = true;
  renderAssistantTrace([
    {
      step: "执行计划",
      detail: "请求后端执行器，浏览器任务执行期间请等待返回结果。",
      status: "running",
      at: new Date().toISOString()
    }
  ]);
  try {
    const response = await fetch("/api/assistant/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project: $("project").value,
        env: $("env").value,
        message: $("assistantMessage").value,
        plan: currentAssistantPlan,
        confirmWrite
      })
    });
    const result = await response.json();
    const completed = result.exitCode === 0;
    $("assistantAssertionUnderstanding").textContent = formatPlanAssertions(planAssertionsFrom(currentAssistantPlan));
    $("assistantAssertionResults").textContent = formatAssertionSummaries(result.assertionSummaries ?? []);
    $("assistantStatus").textContent = completed ? "计划执行完成。" : "计划执行未完成。";
    renderAssistantTrace([
      {
        step: "执行计划",
        detail: completed ? "后端执行器返回成功。" : `后端执行器返回 exitCode=${result.exitCode}。`,
        status: completed ? "completed" : "failed",
        at: new Date().toISOString()
      }
    ]);
    $("assistantPlan").textContent = [
      JSON.stringify(currentAssistantPlan, null, 2),
      "",
      "--- 执行输出 ---",
      formatCommandResult(result)
    ].join("\n");
    await refresh();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    $("assistantStatus").textContent = "计划执行请求失败。";
    renderAssistantTrace([
      {
        step: "执行计划",
        detail: message,
        status: "failed",
        at: new Date().toISOString()
      }
    ]);
    $("assistantPlan").textContent = `${JSON.stringify(currentAssistantPlan, null, 2)}\n\n--- 执行异常 ---\n${message}`;
  } finally {
    $("assistantExecute").disabled = false;
  }
}

function closeConfirmPlanModal() {
  $("confirmPlanModal").classList.add("hidden");
}

async function loadLarkSettings() {
  if (!$("larkSettingsStatus")) return;
  const settings = await fetch("/api/verifications/lark-settings").then((item) => item.json());
  $("larkKeyword").value = settings.keyword || "验证码";
  $("larkSettingsStatus").textContent = settings.hasWebhookUrl
    ? `已配置 Lark：${settings.maskedWebhookUrl}；签名：${settings.hasSignSecret ? settings.maskedSignSecret : "未配置"}`
    : "未配置 Lark webhook。";
}

async function saveLarkSettings() {
  const result = await fetch("/api/verifications/lark-settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      webhookUrl: $("larkWebhookUrl").value,
      signSecret: $("larkSignSecret").value,
      keyword: $("larkKeyword").value
    })
  }).then((item) => item.json());
  $("larkWebhookUrl").value = "";
  $("larkSignSecret").value = "";
  $("larkSettingsStatus").textContent = result.hasWebhookUrl
    ? `已保存 Lark：${result.maskedWebhookUrl}；签名：${result.hasSignSecret ? result.maskedSignSecret : "未配置"}`
    : "未配置 Lark webhook。";
}

async function sendLarkTest() {
  $("verificationConsoleOutput").textContent = "正在发送 Lark 群测试消息...";
  const result = await fetch("/api/verifications/lark-test-send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      account: $("verificationAccount").value,
      purpose: $("verificationPurpose").value
    })
  }).then((item) => item.json());
  $("verificationConsoleOutput").textContent = JSON.stringify(result, null, 2);
}

async function simulateVerification() {
  const code = $("verificationCode").value.trim() || String(Math.floor(100000 + Math.random() * 900000));
  const account = $("verificationAccount").value.trim();
  const purpose = $("verificationPurpose").value.trim();
  const rawText =
    $("verificationRawText").value.trim() || `验证码 ${code}，账号 ${account || "unknown"}，用于 ${purpose || "测试"}`;
  const result = await fetch("/api/verifications/simulate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account, purpose, code, text: rawText })
  }).then((item) => item.json());
  $("verificationConsoleOutput").textContent = JSON.stringify(result, null, 2);
  await loadVerificationInbox();
}

async function loadVerificationInbox() {
  if (!$("verificationRows")) return;
  const params = new URLSearchParams();
  if ($("verificationAccount")?.value) params.set("account", $("verificationAccount").value);
  params.set("limit", "30");
  const payload = await fetch(`/api/verifications/inbox?${params.toString()}`).then((item) => item.json());
  $("verificationRows").innerHTML = (payload.records ?? [])
    .map(
      (item) => `<tr>
        <td>${formatDate(item.receivedAt)}</td>
        <td>${escapeHtml(item.source)}</td>
        <td>${escapeHtml(item.account ?? "")}</td>
        <td><strong>${escapeHtml(item.code ?? "")}</strong></td>
        <td>${item.matchedKeyword ? "命中" : "未命中"}</td>
        <td>${escapeHtml(item.rawText ?? "")}</td>
      </tr>`
    )
    .join("");
}

function startAssistantProgress() {
  $("assistantStatus").textContent = "等待后端返回真实计划进度。";
  assistantPlanningStageEvents = assistantPlanningStageSkeleton();
  updateAssistantConversationMessage("assistantPlanningMessage", "计划生成进度", renderAssistantPlanningStageEventsHtml(), {
    badge: "running",
    status: "running"
  });
  renderAssistantTrace(assistantPlanningStageEvents.map((item) => ({
    step: item.title,
    detail: item.detail,
    status: item.status,
    at: new Date().toISOString()
  })));
  return (finalStatus = "stopped") => {
    if (finalStatus !== "completed") {
      assistantPlanningStageEvents = assistantPlanningStageEvents.map((item) => (item.status === "running" ? { ...item, status: finalStatus } : item));
      updateAssistantConversationMessage("assistantPlanningMessage", "计划生成进度", renderAssistantPlanningStageEventsHtml(), {
        badge: finalStatus === "failed" ? "failed" : "stopped",
        status: finalStatus === "failed" ? "failed" : "failed"
      });
    }
  };
}

function assistantPlanningStageSkeleton() {
  return [
    { id: "load_project_knowledge", title: "加载项目知识", detail: "等待确认当前项目和环境的 Page Model / Operation Manual。", status: "pending" },
    { id: "deepseek_intent_understanding", title: "AI 意图理解", detail: "等待 AI 返回结构化意图；失败会阻断 DSL 生成。", status: "pending" },
    { id: "project_knowledge_retrieval", title: "项目知识检索", detail: "等待按项目检索目标页面、能力、元素和断言。", status: "pending" },
    { id: "dsl_materialization", title: "DSL 物化", detail: "等待本地把已验证项目知识物化为 AutomationCase。", status: "pending" },
    { id: "deepseek_grounded_advisory", title: "AI 压缩审查", detail: "等待 AI 审查已物化 DSL；失败不阻断写入。", status: "pending" },
    { id: "grounded_contract_validation", title: "生成内容可信度校验", detail: "等待校验生成内容是否引用真实项目知识。", status: "pending" },
    { id: "dsl_contract_validation", title: "DSL 契约校验", detail: "等待校验断言、执行边界和可执行性。", status: "pending" }
  ];
}

function renderAssistantPlanningProgress(steps, index, finalStatus = "running") {
  const html = renderAssistantPlanningProgressHtml(steps, index, finalStatus);
  updateAssistantConversationMessage("assistantPlanningMessage", "计划生成进度", html, {
    badge: finalStatus === "completed" ? "ready" : finalStatus === "failed" ? "failed" : "running",
    status: finalStatus === "completed" ? "completed" : finalStatus === "failed" ? "failed" : "running"
  });
}

async function fetchAssistantPlanStream(input) {
  const response = await fetch("/api/assistant/plan-stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: input.project, env: input.env, message: input.message }),
    signal: input.signal
  });
  if (!response.ok) throw new Error(`计划生成请求失败：HTTP ${response.status}`);
  if (!response.body) {
    return response.json();
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";
    for (const chunk of chunks) {
      const line = chunk.split("\n").find((item) => item.startsWith("data: "));
      if (!line) continue;
      const event = JSON.parse(line.slice(6));
      input.onEvent?.(event);
      if (event.type === "complete") finalResult = event.result;
      if (event.type === "error") throw new Error(event.error || "计划生成失败");
    }
  }
  if (!finalResult) throw new Error("计划生成未返回最终结果。");
  return finalResult;
}

function updateAssistantPlanningStageEvent(event) {
  const canonical = assistantPlanningStageSkeleton();
  const existing = assistantPlanningStageEvents.length ? assistantPlanningStageEvents : canonical;
  const eventId = normalizeAssistantPlanningStageId(event.id ?? event.title);
  const index = canonical.findIndex((item) => item.id === eventId);
  if (index < 0) return;
  const eventStatus = normalizePlanningTraceStatus(event.status, "running");
  const merged = canonical.map((stage, stageIndex) => {
    const current = existing.find((item) => item.id === stage.id) ?? stage;
    if (stageIndex < index && ["pending", "running"].includes(current.status)) {
      return { ...current, status: "completed" };
    }
    if (stageIndex === index) {
      return {
        ...current,
        title: stage.title,
        detail: String(event.detail ?? current.detail ?? stage.detail ?? ""),
        status: eventStatus
      };
    }
    return current;
  });
  assistantPlanningStageEvents = merged;
  const html = renderAssistantPlanningStageEventsHtml();
  updateAssistantConversationMessage("assistantPlanningMessage", "计划生成进度", html, {
    badge: merged.some((item) => item.status === "running") ? "running" : merged.some((item) => item.status === "failed") ? "failed" : "ready",
    status: merged.some((item) => item.status === "failed") ? "failed" : merged.some((item) => item.status === "running") ? "running" : "completed"
  });
  $("assistantStatus").textContent = canonical[index].title;
}

function renderAssistantPlanningStageEventsHtml(finalStatus = "") {
  const items = assistantPlanningStageEvents.length
    ? assistantPlanningStageEvents.map((item) => ({ ...item, status: finalStatus === "completed" && item.status === "running" ? "completed" : item.status }))
    : [{ title: "等待后端计划结果", detail: "计划阶段不使用前端模拟跳步；返回后会展示后端真实事件。", status: finalStatus === "failed" ? "failed" : "running" }];
  return `<ol class="assistant-step-progress-list planning-progress-list">${items.map((item) => `<li class="${escapeHtml(item.status)}">
    <span class="step-progress-icon">${assistantStepProgressIcon(item.status)}</span>
    <div><strong>${escapeHtml(item.title)}</strong>${item.detail ? `<p>${escapeHtml(item.detail)}</p>` : ""}</div>
  </li>`).join("")}</ol>`;
}

function normalizeAssistantPlanningStageId(value) {
  const raw = String(value ?? "").trim();
  const aliases = {
    intent: "deepseek_intent_understanding",
    "理解需求": "deepseek_intent_understanding",
    "AI 意图理解": "deepseek_intent_understanding",
    "DeepSeek intent understanding": "deepseek_intent_understanding",
    capability_match: "project_knowledge_retrieval",
    knowledge_retrieval: "project_knowledge_retrieval",
    "匹配页面与能力": "project_knowledge_retrieval",
    "检索页面知识": "project_knowledge_retrieval",
    mapping: "dsl_materialization",
    materialize: "dsl_materialization",
    "映射元素与断言": "dsl_materialization",
    "物化执行 DSL": "dsl_materialization",
    dsl_advisor: "deepseek_grounded_advisory",
    "生成执行 DSL": "deepseek_grounded_advisory",
    "生成 DSL 建议": "deepseek_grounded_advisory",
    "AI 压缩审查": "deepseek_grounded_advisory",
    validation: "dsl_contract_validation",
    "校验执行计划": "dsl_contract_validation",
    "校验用例 DSL": "dsl_contract_validation"
  };
  return aliases[raw] ?? raw;
}

function assistantPlanningProgressSteps() {
  return [
    ["加载项目知识", "确认当前 project/env 的知识入口。"],
    ["AI 意图理解", "解析自然语言目标，失败时阻断。"],
    ["项目知识检索", "查找 Page Model 与操作手册。"],
    ["DSL 物化", "把已验证知识物化为 AutomationCase。"],
    ["AI 压缩审查", "审查已物化 DSL，失败不阻断写入。"],
    ["生成内容可信度校验", "检查生成内容是否引用真实项目知识。"],
    ["DSL 契约校验", "检查断言、确认点和执行边界。"]
  ];
}

function renderAssistantPlanningTrace(trace, fallbackStatus = "completed") {
  const items = Array.isArray(trace) && trace.length
    ? trace.map((item) => [
      String(item.step ?? item.stage ?? "计划阶段"),
      String(item.detail ?? item.message ?? ""),
      normalizePlanningTraceStatus(item.status, fallbackStatus)
    ])
    : [["后端计划结果", "后端已返回计划结果。", fallbackStatus]];
  const html = `<ol class="assistant-step-progress-list planning-progress-list">${items.map((item) => {
    const status = item[2];
    return `<li class="${escapeHtml(status)}">
      <span class="step-progress-icon">${assistantStepProgressIcon(status)}</span>
      <div><strong>${escapeHtml(item[0])}</strong>${item[1] ? `<p>${escapeHtml(item[1])}</p>` : ""}</div>
    </li>`;
  }).join("")}</ol>`;
  updateAssistantConversationMessage("assistantPlanningMessage", "计划生成进度", html, {
    badge: items.some((item) => item[2] === "failed") ? "failed" : "ready",
    status: items.some((item) => item[2] === "failed") ? "failed" : "completed"
  });
  return html;
}

function renderAssistantPlanningTraceDetails(trace) {
  if (!Array.isArray(trace) || !trace.length) return `<div class="empty-card">后端没有返回 trace 明细。</div>`;
  return `<ol class="assistant-step-progress-list planning-progress-list">${trace.map((item) => {
    const status = normalizePlanningTraceStatus(item.status, "completed");
    return `<li class="${escapeHtml(status)}">
      <span class="step-progress-icon">${assistantStepProgressIcon(status)}</span>
      <div><strong>${escapeHtml(item.step ?? item.stage ?? "计划阶段")}</strong>${item.detail || item.message ? `<p>${escapeHtml(item.detail ?? item.message)}</p>` : ""}</div>
    </li>`;
  }).join("")}</ol>`;
}

function normalizePlanningTraceStatus(status, fallbackStatus) {
  const value = String(status ?? fallbackStatus ?? "").toLowerCase();
  if (["failed", "error", "blocked"].includes(value)) return "failed";
  if (value === "warning") return "warning";
  if (value === "cancelled" || value === "cancelling") return value;
  if (value === "skipped") return "skipped";
  if (["running", "pending"].includes(value)) return value;
  return "completed";
}

function renderAssistantPlanningProgressHtml(steps, index, finalStatus = "running") {
  return `<ol class="assistant-step-progress-list planning-progress-list">${steps.map((step, itemIndex) => {
    const status = finalStatus === "failed"
      ? itemIndex < index ? "completed" : itemIndex === index ? "failed" : "pending"
      : finalStatus === "completed" || itemIndex < index
        ? "completed"
        : itemIndex === index
          ? "running"
          : "pending";
    return `<li class="${escapeHtml(status)}">
      <span class="step-progress-icon">${assistantStepProgressIcon(status)}</span>
      <div><strong>${escapeHtml(step[0])}</strong><p>${escapeHtml(step[1])}</p></div>
    </li>`;
  }).join("")}</ol>`;
}

function renderAssistantTrace(trace) {
  $("assistantTrace").innerHTML = [...trace]
    .reverse()
    .map(
      (item) => `<div class="trace-item ${escapeHtml(item.status)}">
        <span>${escapeHtml(assistantTraceStatusText(item.status))}</span>
        <strong>${escapeHtml(item.step ?? item.stage ?? "")}</strong>
        <p>${escapeHtml(item.detail ?? item.message ?? "")}</p>
      </div>`
    )
    .join("");
  $("assistantTrace").scrollTop = 0;
}

function renderAssistantKnowledge(chunks) {
  $("assistantKnowledgeRows").innerHTML = chunks
    .map(
      (item) => `<tr>
        <td>${escapeHtml(item.title)}</td>
        <td>${escapeHtml(item.sourceType)}${item.surface ? ` / ${escapeHtml(surfaceName(item.surface))}` : ""}</td>
        <td>${Math.round((item.confidence ?? 0) * 100)}%</td>
        <td>${escapeHtml(item.content)}</td>
      </tr>`
    )
    .join("");
}

function traceStatusText(status) {
  if (status === "running") return "进行中";
  if (status === "needs_confirmation") return "待确认";
  if (status === "failed") return "失败";
  return "完成";
}

async function uploadAppArchive() {
  const file = $("apkFile").files?.[0];
  if (!file) {
    $("exploreConsoleOutput").textContent = "请先选择 APK 文件。";
    return;
  }
  $("exploreConsoleOutput").textContent = "应用上传中...";
  const contentBase64 = await fileToBase64(file);
  const response = await fetch("/api/uploads/app", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project: $("project").value,
      env: $("env").value,
      filename: file.name,
      version: $("appVersion").value,
      contentBase64
    })
  });
  const result = await response.json();
  if (result.filePath) $("apk").value = result.filePath;
  $("exploreConsoleOutput").textContent = result.error ? result.error : `已上传归档：${result.filePath}`;
  await refresh();
}

async function refresh() {
  if (projectCatalog.length === 0) await loadProjects();
  const project = encodeURIComponent($("project").value || projectCatalog[0]?.key || "demo");
  const env = encodeURIComponent($("env").value || currentProject()?.defaultEnv || "test");
  const [summary, graph] = await Promise.all([
    fetch(`/api/summary?project=${project}&env=${env}`).then((item) => item.json()),
    fetch(`/api/page-graph?project=${project}&env=${env}`).then((item) => item.json())
  ]);
  const [appArchive, knowledge] = await Promise.all([
    fetch(`/api/app-archives?project=${project}&env=${env}`).then((item) => item.json()),
    fetch(`/api/knowledge?project=${project}&env=${env}&limit=5`).then((item) => item.json())
  ]);

  const results = summary.latestResults?.results ?? [];
  $("nodeCount").textContent = String(summary.graph?.nodes ?? 0);
  $("edgeCount").textContent = String(summary.graph?.edges ?? 0);
  $("knowledgeCount").textContent = String(knowledge.total ?? 0);
  $("caseCount").textContent = String(results.length);
  $("failedCount").textContent = String(results.filter((item) => item.status === "failed").length);
  renderResults(results);
  renderGraph(graph);
  renderAppArchives(appArchive);
  renderKnowledge(knowledge.chunks ?? []);
  renderExploreEnvSummary();
  await Promise.all([
    loadAccounts(),
    loadAccountProfiles(),
    loadExploreAccounts(),
    loadEnvironmentDiscovery(),
    loadElements(),
    loadTasks(),
    loadExecution(),
    loadCases(),
    loadBootstrapScans(),
    loadVerificationInbox()
  ]);
  if ($("projectCapabilities")?.classList.contains("active")) await loadProjectCapabilities();
}

async function loadAccounts() {
  const project = $("accountProjectFilter").value || $("project").value || "";
  const env = $("accountEnvFilter").value || $("env").value || "";
  const username = $("accountKeyword").value || "";
  const params = new URLSearchParams();
  if (project) params.set("project", project);
  if (env) params.set("env", env);
  if (username) params.set("username", username);
  const payload = await fetch(`/api/accounts?${params.toString()}`).then((item) => item.json());
  currentAccountTotpReadiness = new Map();
  renderAccounts(payload.accounts ?? []);
}

async function loadAccountProfiles() {
  if (!$("accountProfileRows")) return;
  const project = $("accountProjectFilter").value || $("project").value || "demo";
  const env = $("accountEnvFilter").value || $("env").value || "test";
  const payload = await fetch(`/api/account-profiles?project=${encodeURIComponent(project)}&env=${encodeURIComponent(env)}`).then((item) => item.json()).catch(() => ({ profile: { profiles: [] } }));
  renderAccountProfiles(payload);
}

async function loadExploreAccounts() {
  const params = new URLSearchParams();
  params.set("project", $("project").value || "");
  params.set("env", $("env").value || "");
  const payload = await fetch(`/api/accounts?${params.toString()}`).then((item) => item.json());
  syncExploreAccounts(payload.accounts ?? []);
}

async function saveAccount() {
  await saveAccountPayload({
    id: $("accountEditId").value || undefined,
    project: $("accountProjectFilter").value || $("project").value,
    env: $("accountEnvFilter").value || $("env").value,
    username: $("accountUsername").value,
    password: $("accountPassword").value,
    label: $("accountLabel").value
  });
}

async function saveAccountPayload(payload) {
  const result = await fetch("/api/accounts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  }).then((item) => item.json());
  $("runConsoleOutput").textContent = result.error ? result.error : `账号已保存：${result.username}`;
  if (!result.error) clearAccountEditForm(false);
  await Promise.all([loadAccounts(), loadAccountProfiles(), loadExploreAccounts()]);
  return result;
}

function renderAccounts(accounts) {
  $("accountRows").innerHTML = accounts
    .map(
      (item) => {
        const gaTitle = "查看当前 GA 验证码";
        return `<tr>
        <td>${escapeHtml(item.project)}</td>
        <td>${escapeHtml(item.env)}</td>
        <td>${escapeHtml(item.username)}</td>
        <td><span class="account-password-mask" title="点击显示/隐藏">••••••</span><span hidden>${escapeHtml(item.password)}</span></td>
        <td>${escapeHtml(item.label ?? "")}</td>
        <td>${formatDate(item.updatedAt)}</td>
        <td><div class="account-action-buttons">
          <button type="button" class="link-button account-edit" data-account="${escapeHtml(item.id)}">编辑</button>
          <button type="button" class="secondary-button account-ga-button" data-account="${escapeHtml(item.id)}" title="${escapeHtml(gaTitle)}">GA</button>
        </div></td>
      </tr>`;
      }
    )
    .join("");
  document.querySelectorAll(".account-edit").forEach((button) => {
    button.addEventListener("click", () => {
      const account = accounts.find((item) => item.id === button.dataset.account);
      if (!account) return;
      openAccountModal(account);
    });
  });
  document.querySelectorAll(".account-ga-button").forEach((button) => {
    button.addEventListener("click", () => {
      const account = accounts.find((item) => item.id === button.dataset.account);
      if (!account) return;
      openAccountGaModal(account);
    });
  });
}

function accountGaUnavailableText(readiness) {
  if (!readiness) return "GA 不可用：未读取到本地 TOTP 状态";
  return {
    provider_not_configured: "GA 不可用：当前项目环境未配置 TOTP provider",
    provider_unimplemented: "GA 不可用：当前 TOTP provider 未实现",
    entry_missing: "GA 不可用：账号未配置本地 TOTP entry",
    database_unlock_failed: "GA 不可用：KeePassXC 数据库解锁失败",
    totp_unreadable: "GA 不可用：本地 TOTP 不可读"
  }[readiness.status] ?? "GA 不可用";
}

function openAccountModal(account) {
  $("accountEditId").value = account?.id ?? "";
  $("accountModalTitle").textContent = account ? "编辑账号" : "新增账号";
  syncAccountModalProjectOptions();
  $("accountModalProject").value = account?.project ?? $("project").value;
  syncAccountModalEnvOptions();
  $("accountModalEnv").value = account?.env ?? $("env").value;
  $("accountModalUsername").value = account?.username ?? "";
  $("accountModalPassword").value = account?.password ?? "";
  $("accountModalLabel").value = account?.label ?? "";
  $("accountModal").classList.remove("hidden");
  $("accountModalUsername").focus();
}

function closeAccountModal() {
  $("accountModal").classList.add("hidden");
}

async function openAccountGaModal(account) {
  $("accountGaUsername").textContent = account.username ?? "";
  $("accountGaCode").textContent = "------";
  $("accountGaStatus").textContent = "正在读取 GA...";
  $("accountGaModal").classList.remove("hidden");
  try {
    const payload = await fetch("/api/accounts/totp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project: account.project,
        env: account.env,
        username: account.username
      })
    }).then((item) => item.json());
    if (!payload.ok) {
      $("accountGaCode").textContent = "------";
      $("accountGaStatus").textContent = accountGaUnavailableText(payload) || payload.error || "GA 不可用";
      return;
    }
    $("accountGaCode").textContent = payload.code ?? "------";
    $("accountGaStatus").textContent = payload.expiresInSeconds ? `约 ${payload.expiresInSeconds} 秒后刷新` : "";
  } catch (error) {
    $("accountGaCode").textContent = "------";
    $("accountGaStatus").textContent = error?.message ?? String(error);
  }
}

function closeAccountGaModal() {
  $("accountGaCode").textContent = "";
  $("accountGaStatus").textContent = "";
  $("accountGaUsername").textContent = "";
  $("accountGaModal").classList.add("hidden");
}

async function saveAccountFromModal() {
  const result = await saveAccountPayload({
    id: $("accountEditId").value || undefined,
    project: $("accountModalProject").value,
    env: $("accountModalEnv").value,
    username: $("accountModalUsername").value,
    password: $("accountModalPassword").value,
    label: $("accountModalLabel").value
  });
  if (!result.error) closeAccountModal();
}

function resetAccountFilters() {
  $("accountProjectFilter").value = $("project").value;
  syncAccountEnvFilters();
  $("accountEnvFilter").value = $("env").value;
  $("accountKeyword").value = "";
  refreshAccountArea();
}

async function refreshAccountArea() {
  await Promise.all([loadAccounts(), loadAccountProfiles()]);
}

async function refreshAccountProfilesFromDatabase(username = "") {
  const status = $("accountProfileRefreshStatus");
  const project = $("accountProjectFilter")?.value || $("project")?.value || "demo";
  const env = $("accountEnvFilter")?.value || $("env")?.value || "test";
  const selectedUsername = String(username || "").trim();
  if (status) status.textContent = selectedUsername ? `正在刷新 ${selectedUsername} 的数据库画像...` : "正在刷新当前项目环境的全部数据库画像...";
  try {
    const payload = await fetch("/api/account-profiles/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project, env, username: selectedUsername || undefined })
    }).then((item) => item.json());
    if (!payload.ok) {
      if (status) {
        status.innerHTML = `<span class="status-text-failed">${escapeHtml(payload.status ?? "刷新失败")}</span>：${escapeHtml(payload.diagnostics?.reason ?? payload.error ?? "请查看后端诊断。")}`;
      }
      return;
    }
    if (status) {
      const count = Array.isArray(payload.refreshedProfiles) ? payload.refreshedProfiles.length : 0;
      status.innerHTML = `<span class="status-text-passed">画像已刷新</span>，更新 ${escapeHtml(String(count))} 个账号，来源 ${escapeHtml(payload.sourceId ?? "-")}。`;
    }
    await refreshAccountArea();
    const profile = (currentAccountProfilePayload?.profile?.profiles ?? []).find((item) =>
      selectedUsername ? String(item.username ?? "").toLowerCase() === selectedUsername.toLowerCase() : false
    );
    if (profile) renderAccountProfileDetail(profile);
  } catch (error) {
    if (status) status.innerHTML = `<span class="status-text-failed">画像刷新失败</span>：${escapeHtml(error?.message ?? String(error))}`;
  }
}

function syncAccountModalProjectOptions() {
  $("accountModalProject").innerHTML = projectCatalog
    .map((item) => `<option value="${escapeHtml(item.key)}">${escapeHtml(item.name)}</option>`)
    .join("");
}

function syncAccountModalEnvOptions() {
  const project = projectCatalog.find((item) => item.key === $("accountModalProject").value) ?? currentProject();
  const envs = project?.envs ?? [];
  const previous = $("accountModalEnv").value;
  $("accountModalEnv").innerHTML = envs
    .map((item) => `<option value="${escapeHtml(item.key)}">${escapeHtml(item.name)}</option>`)
    .join("");
  $("accountModalEnv").value = envs.some((item) => item.key === previous) ? previous : project?.defaultEnv ?? envs[0]?.key ?? "";
}

function clearAccountEditForm(clearValues = true) {
  $("accountEditId").value = "";
  $("saveAccount").textContent = "保存账号";
  if (!clearValues) return;
  $("accountUsername").value = "";
  $("accountPassword").value = "";
  $("accountLabel").value = "";
}
function syncExploreAccounts(accounts) {
  const current = $("exploreAccount").value;
  const sortedAccounts = [...accounts].sort((a, b) => exploreAccountScore(b) - exploreAccountScore(a));
  $("exploreAccount").innerHTML =
    `<option value="">手动输入</option>` +
    sortedAccounts
      .map((item) => {
        const label = item.label ? `${item.username} - ${item.label}` : item.username;
        return `<option value="${escapeHtml(item.id)}">${escapeHtml(label)}</option>`;
      })
      .join("");
  const currentStillAvailable = sortedAccounts.some((item) => item.id === current);
  $("exploreAccount").value = currentStillAvailable ? current : "";
  $("exploreAccount").dataset.accounts = JSON.stringify(sortedAccounts);
  if (!currentStillAvailable) {
    $("exploreUsername").value = "";
    $("explorePassword").value = "";
  }
  if (!$("exploreUsername").value && sortedAccounts[0]) {
    $("exploreAccount").value = sortedAccounts[0].id;
    fillExploreAccount();
  }
  $("exploreAccount").dataset.count = String(sortedAccounts.length);
  renderExploreEnvSummary();
}

function clearExploreAccountFields() {
  $("exploreAccount").value = "";
  $("exploreUsername").value = "";
  $("explorePassword").value = "";
}

function renderExploreEnvSummary() {
  if (!$("exploreEnvSummary")) return;
  const env = currentEnv();
  const accountCount = $("exploreAccount")?.dataset.count ?? "0";
  $("exploreEnvSummary").innerHTML = `
    <strong>当前探索环境</strong>
    <span>项目：${escapeHtml(currentProject()?.name ?? $("project").value)}</span>
    <span>环境：${escapeHtml(env?.name ?? $("env").value)}</span>
    <span>用户站点：${escapeHtml(env?.webBaseUrl ?? "")}</span>
    <span>现货后台：${escapeHtml(env?.spotAdminBaseUrl ?? "")}</span>
    <span>可用账号：${escapeHtml(accountCount)}</span>
  `;
}

function exploreAccountScore(account) {
  const value = `${account.username ?? ""} ${account.label ?? ""}`.toLowerCase();
  if (value.includes("bypass")) return 100;
  if (value.includes("uat")) return 20;
  return 0;
}

function fillExploreAccount() {
  const accountId = $("exploreAccount").value;
  if (!accountId) return;
  const accounts = JSON.parse($("exploreAccount").dataset.accounts || "[]");
  const account = accounts.find((item) => item.id === accountId);
  if (!account) return;
  $("exploreUsername").value = account.username;
  $("explorePassword").value = account.password;
}

async function loadEnvironmentDiscovery() {
  const project = encodeURIComponent($("project").value || "demo");
  const env = encodeURIComponent($("env").value || "test");
  const discovery = await fetch(`/api/environment-discovery?project=${project}&env=${env}`).then((item) => item.json());
  $("envDomains").value = (discovery.domains ?? []).join("\n");
  $("envApis").value = (discovery.apiEndpoints ?? [])
    .map((item) => `${item.method ? `${item.method} ` : ""}${item.url}`)
    .join("\n");
  $("envNotes").value = discovery.notes ?? "";
  $("bypassEnabled").checked = Boolean(discovery.bypassLogin?.enabled);
  $("bypassPath").value = discovery.bypassLogin?.path ?? "/spot/api/bypass/captcha/login_in";
  $("tokenHeaderName").value = discovery.bypassLogin?.tokenHeaderName ?? "token";
  $("tokenResponsePath").value = discovery.bypassLogin?.tokenResponsePath ?? "data.token";
  $("authStorageKeys").value = (discovery.authInjection?.storageKeys ?? [
    "token",
    "TOKEN",
    "userToken",
    "accessToken",
    "access_token",
    "authToken",
    "Authorization",
    "loginToken"
  ]).join("\n");
  $("authCookieNames").value = (discovery.authInjection?.cookieNames ?? ["token"]).join("\n");
}

async function saveEnvironmentDiscovery() {
  const result = await fetch("/api/environment-discovery", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project: $("project").value,
      env: $("env").value,
      domains: $("envDomains").value,
      apiEndpoints: $("envApis").value,
      notes: $("envNotes").value,
      bypassEnabled: $("bypassEnabled").checked,
      bypassPath: $("bypassPath").value,
      tokenHeaderName: $("tokenHeaderName").value,
      tokenResponsePath: $("tokenResponsePath").value,
      authStorageKeys: $("authStorageKeys").value,
      authCookieNames: $("authCookieNames").value
    })
  }).then((item) => item.json());
  $("runConsoleOutput").textContent = result.error ? result.error : "环境发现已保存。";
}

async function loadTasks() {
  const payload = await fetch("/api/tasks").then((item) => item.json());
  if (payload.webExplore?.running) setWebExploreRunning(true);
  if ($("taskRows")) {
    const task = payload.webExplore ?? { running: false };
    $("taskRows").innerHTML = `<tr>
      <td>Web 探索</td>
      <td>${task.running ? "运行中" : "空闲"}</td>
      <td>${escapeHtml(task.pid ?? "")}</td>
      <td>${formatDate(task.startedAt)}</td>
      <td><code>${escapeHtml(task.command ?? "")}</code></td>
    </tr>`;
  }
}

async function loadElements() {
  if (!$("elementRows")) return;
  const project = encodeURIComponent($("project").value || "demo");
  const env = encodeURIComponent($("env").value || "test");
  const payload = await fetch(`/api/elements?project=${project}&env=${env}`).then((item) => item.json());
  $("elementRows").innerHTML = (payload.elements ?? [])
    .map(
      (item) => `<tr>
        <td>${escapeHtml(item.pageName)}<br><span class="muted">${escapeHtml(item.url)}</span></td>
        <td>${escapeHtml(item.role)}</td>
        <td>${escapeHtml(item.text ?? "")}</td>
        <td>${escapeHtml(formatElementField(item))}</td>
        <td><code>${escapeHtml(item.selector)}</code></td>
        <td>${escapeHtml(item.riskLevel)}</td>
        <td>${formatDate(item.lastSeenAt)}</td>
      </tr>`
    )
    .join("");
}

function renderAccountProfiles(payload) {
  currentAccountProfilePayload = payload;
  const profiles = payload?.profile?.profiles ?? [];
  const status = $("accountProfileStatus");
  if (status) {
    status.textContent = profiles.length
      ? `已加载 ${profiles.length} 个账号画像，项目 ${payload.project ?? "-"}，环境 ${payload.env ?? "-"}。`
      : "当前项目/环境暂无账号画像。";
  }
  $("accountProfileRows").innerHTML = profiles
    .map((profile) => {
      const dimensions = profile.dimensions ?? {};
      const values = Object.values(dimensions);
      const known = values.filter((item) => ["known", "matched"].includes(String(item?.status ?? ""))).length;
      const unknown = values.filter((item) => ["unknown", "candidate"].includes(String(item?.status ?? ""))).length;
      const stale = values.filter((item) => String(item?.status ?? "") === "stale").length;
      const tags = (profile.locationTags ?? []).map((item) => `${accountProfileTagLabel(item.tag)}:${accountProfileStatusLabel(item.status)}`).join(" / ");
      const selectedClass = String(profile.username ?? "").toLowerCase() === String(currentSelectedAccountProfileUsername ?? "").toLowerCase() ? " class=\"selected-row\"" : "";
      return `<tr${selectedClass}>
        <td><button type="button" class="link-button account-profile-link" data-account-profile="${escapeHtml(profile.username)}">${escapeHtml(profile.username)}</button></td>
        <td>${escapeHtml(accountProfileStatusLabel(profile.profileStatus))}</td>
        <td>${escapeHtml(tags || "-")}</td>
        <td>${escapeHtml(String(known))}</td>
        <td>${escapeHtml(String(unknown))}</td>
        <td>${escapeHtml(String(stale))}</td>
      </tr>`;
    })
    .join("");
  document.querySelectorAll(".account-profile-link").forEach((button) => {
    button.addEventListener("click", () => {
      const username = button.dataset.accountProfile ?? "";
      const row = profiles.find((item) => item.username === username);
      if (!row) return;
      currentSelectedAccountProfileUsername = username;
      renderAccountProfileDetail(row);
    });
  });
  const selectedProfile = profiles.find((item) => String(item.username ?? "").toLowerCase() === String(currentSelectedAccountProfileUsername ?? "").toLowerCase());
  if (selectedProfile) renderAccountProfileDetail(selectedProfile);
}

function renderAccountProfileDetail(profile) {
  currentSelectedAccountProfileUsername = profile.username ?? "";
  const dimensions = profile.dimensions ?? {};
  const detail = $("accountProfileDetail");
  if (detail) {
    detail.innerHTML = accountProfileDetailHtml(profile);
  }
  if ($("runConsoleOutput")) {
    const lines = [
      `账号：${profile.username}`,
      `画像状态：${profile.profileStatus ?? "-"}`,
      `定位：${(profile.locationTags ?? []).map((item) => `${item.tag}:${item.status}`).join(" / ") || "-"}`,
      "",
      ...Object.entries(dimensions).map(([key, value]) => `${key}: ${value?.status ?? "-"}${value?.value !== undefined ? ` = ${value.value}` : ""}${value?.source ? ` (${value.source})` : ""}`)
    ];
    $("runConsoleOutput").textContent = lines.join("\n");
  }
}

function accountProfileDetailHtml(profile) {
  const dimensions = profile?.dimensions ?? {};
  const rows = accountProfileDisplayRows(dimensions).map(({ key, label, value }) => `<tr>
    <td title="${escapeHtml(key)}">${escapeHtml(label)}</td>
    <td title="${escapeHtml(value?.value !== undefined ? String(value.value) : "-")}">${escapeHtml(formatAccountProfileValue(key, value?.value))}</td>
    <td>${escapeHtml(accountProfileStatusLabel(value?.status))}</td>
    <td>${escapeHtml(formatDate(value?.updatedAt))}</td>
  </tr>`).join("");
  const diagnosticRows = Object.entries(dimensions).map(([key, value]) => `<tr>
    <td title="${escapeHtml(key)}">${escapeHtml(key)}</td>
    <td>${escapeHtml(accountProfileStatusLabel(value?.status))}</td>
    <td title="${escapeHtml(value?.value !== undefined ? String(value.value) : "-")}">${escapeHtml(value?.value !== undefined ? String(value.value) : "-")}</td>
    <td>${escapeHtml(accountProfileSourceLabel(value?.source))}</td>
    <td title="${escapeHtml(value?.evidence ? JSON.stringify(value.evidence) : "-")}">${escapeHtml(accountProfileEvidenceSummary(value?.evidence))}</td>
  </tr>`).join("");
  return `<div class="account-profile-detail-head">
      <div>
        <strong>${escapeHtml(profile?.username ?? "-")}</strong>
        <span>${escapeHtml(profile?.label ?? "")}</span>
      </div>
      <span class="status-tag status-idle">${escapeHtml(accountProfileStatusLabel(profile?.profileStatus))}</span>
    </div>
    <div class="account-profile-tags">${(profile?.locationTags ?? []).map((item) => `<span title="${escapeHtml(item.reason ?? "")}">${escapeHtml(accountProfileTagLabel(item.tag))}:${escapeHtml(accountProfileStatusLabel(item.status))}</span>`).join("") || "<span>-</span>"}</div>
    <div class="table-wrap account-profile-dimension-wrap">
      <table>
        <thead><tr><th>画像项</th><th>当前值</th><th>状态</th><th>更新时间</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4">暂无可展示画像。</td></tr>`}</tbody>
      </table>
    </div>
    <details class="conversation-details account-profile-diagnostics">
      <summary>高级诊断</summary>
      <div class="table-wrap account-profile-dimension-wrap">
        <table>
          <thead><tr><th>原始维度</th><th>状态</th><th>原始值</th><th>来源</th><th>证据</th></tr></thead>
          <tbody>${diagnosticRows || `<tr><td colspan="5">暂无诊断数据。</td></tr>`}</tbody>
        </table>
      </div>
    </details>`;
}

async function openAccountProfile(username, project = selectedWorkbenchProject(), env = selectedWorkbenchEnv()) {
  if (!username || username === "-") return;
  const modal = $("accountProfileModal");
  const body = $("accountProfileModalBody");
  if (!modal || !body) return;
  modal.classList.remove("hidden");
  body.innerHTML = `<div class="muted">正在加载 ${escapeHtml(username)} 的账号画像...</div>`;
  try {
    const payload = await fetch(`/api/account-profiles?project=${encodeURIComponent(project)}&env=${encodeURIComponent(env)}`).then((item) => item.json());
    currentAccountProfilePayload = payload;
    const profiles = payload?.profile?.profiles ?? [];
    const profile = profiles.find((item) => String(item.username ?? "").toLowerCase() === String(username).toLowerCase());
    if (!profile) {
      body.innerHTML = `<div class="assistant-status error">未找到账号画像：${escapeHtml(username)}（${escapeHtml(project)} / ${escapeHtml(env)}）。</div>`;
      return;
    }
    currentSelectedAccountProfileUsername = profile.username ?? username;
    body.innerHTML = accountProfileDetailHtml(profile);
  } catch (error) {
    body.innerHTML = `<div class="assistant-status error">${escapeHtml(error?.message ?? String(error))}</div>`;
  }
}

function closeAccountProfileModal() {
  $("accountProfileModalBody").innerHTML = "";
  $("accountProfileModal").classList.add("hidden");
}

function renderAccountProfileInlineLink(username) {
  if (!username || username === "-") return escapeHtml(username ?? "-");
  return `<button type="button" class="link-button account-profile-jump" data-account-username="${escapeHtml(username)}" title="查看账号画像">${escapeHtml(username)}</button>`;
}

function bindAccountProfileJumpLinks(root = document) {
  root.querySelectorAll(".account-profile-jump").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openAccountProfile(button.dataset.accountUsername ?? "");
    });
  });
}

function accountProfileDisplayRows(dimensions) {
  return Object.entries(dimensions ?? {})
    .map(([key, value]) => ({ key, label: accountProfileDimensionLabel(key), value }))
    .filter((item) => item.label)
    .sort((a, b) => accountProfileDimensionOrder(a.key) - accountProfileDimensionOrder(b.key) || a.label.localeCompare(b.label, "zh-Hans-CN"));
}

function accountProfileDimensionOrder(key) {
  if (key.startsWith("profile.")) return 10;
  if (key.startsWith("identity.")) return 20;
  if (key.startsWith("security.")) return 30;
  if (key.startsWith("assets.spot.")) return 40;
  if (key.startsWith("assets.earn.")) return 50;
  if (key.startsWith("history.")) return 60;
  return 90;
}

function accountProfileDimensionLabel(key) {
  const exact = {
    "profile.uid": "用户 UID",
    "profile.deleted": "账号已删除",
    "identity.kyc": "KYC 状态",
    "security.emailBound": "已绑定邮箱",
    "security.phoneBound": "已绑定手机",
    "security.googleAuthenticatorBound": "已绑定 Google 验证器",
    "security.mobileAuthenticatorBound": "已开启手机验证",
    "security.loginEnabled": "登录可用",
    "security.tradeEnabled": "交易可用",
    "security.withdrawEnabled": "提现可用"
  };
  if (exact[key]) return exact[key];
  let match = key.match(/^assets\.spot\.([^.]+)\.(available|frozen|withdrawPending)$/);
  if (match) {
    const metric = { available: "可用余额", frozen: "冻结余额", withdrawPending: "提现中余额" }[match[2]];
    return `现货 ${match[1]} ${metric}`;
  }
  match = key.match(/^assets\.earn\.([^.]+)\.(positionAmount|redeemableAmount|frozenAmount)$/);
  if (match) {
    const metric = { positionAmount: "持仓", redeemableAmount: "可赎回", frozenAmount: "冻结" }[match[2]];
    return `理财 ${match[1]} ${metric}`;
  }
  match = key.match(/^history\.(.+)$/);
  if (match) return `历史数据 ${match[1]}`;
  return "";
}

function accountProfileStatusLabel(status) {
  return {
    known: "已知",
    matched: "已满足",
    unmatched: "不满足",
    unknown: "未知",
    candidate: "候选",
    stale: "已过期",
    database_modeled: "数据库已建模",
    api_modeled: "接口已建模",
    manual: "人工维护"
  }[String(status ?? "")] ?? String(status ?? "-");
}

function accountProfileSourceLabel(source) {
  return {
    database_probe: "数据库探测",
    api_probe: "接口探测",
    manual: "人工维护",
    execution: "执行结果"
  }[String(source ?? "")] ?? String(source ?? "-");
}

function accountProfileTagLabel(tag) {
  return {
    read_only_query: "查询类账号",
    write_asset_operation: "资产写操作",
    earn_position_operation: "理财持仓",
    withdraw_address_operation: "提现地址",
    red_packet_operation: "红包操作",
    provider_verification_ready: "双验证就绪",
    auxiliary_target_account: "辅助目标账号"
  }[String(tag ?? "")] ?? String(tag ?? "-");
}

function formatAccountProfileValue(key, value) {
  if (value === true) return "是";
  if (value === false) return "否";
  if (key === "identity.kyc") {
    return { not_started: "未认证", passed_level: "已通过" }[String(value)] ?? String(value ?? "-");
  }
  return value !== undefined && value !== null ? String(value) : "-";
}

function accountProfileEvidenceSummary(evidence) {
  if (!evidence || typeof evidence !== "object") return "-";
  const table = evidence.table ? `表:${evidence.table}` : "";
  const field = evidence.field ? `字段:${evidence.field}` : "";
  const reportPath = evidence.reportPath ? String(evidence.reportPath) : "";
  return [table, field, reportPath].filter(Boolean).join(" / ") || "-";
}

async function loadCases() {
  if (!$("caseRows")) return;
  const project = encodeURIComponent($("project").value || "demo");
  const env = encodeURIComponent($("env").value || "test");
  $("caseStatusText").textContent = "正在加载用例...";
  const payload = await fetch(`/api/cases?project=${project}&env=${env}`).then((item) => item.json());
  currentCaseAssets = payload.cases ?? [];
  currentCasePage = 1;
  renderCases(currentCaseAssets);
  updateCaseListFooter();
  renderAssistantRunHistory(currentCaseAssets);
}

function renderCases(cases) {
  if (!$("caseRows")) return;
  if (!currentSelectedCaseId || !cases.some((item) => item.id === currentSelectedCaseId)) currentSelectedCaseId = cases[0]?.id ?? "";
  const totalPages = Math.max(1, Math.ceil(cases.length / CASE_PAGE_SIZE));
  currentCasePage = Math.min(Math.max(1, currentCasePage), totalPages);
  const pageCases = cases.slice((currentCasePage - 1) * CASE_PAGE_SIZE, currentCasePage * CASE_PAGE_SIZE);
  $("caseRows").innerHTML = pageCases
    .map((item) => {
      const dsl = item.latestDsl;
      const latestRun = latestCaseRunForCurrentContext(item);
      const dslState = dsl
        ? `${dsl.executable ? "可执行" : "不可执行"} / r${dsl.revision}`
        : "未生成";
      const dslClass = !dsl ? "case-dsl-missing" : !dsl.executable ? "case-dsl-gap" : "case-dsl-ready";
      const runClass = latestRun?.status === "passed" ? "status-passed" : latestRun?.status === "failed" ? "status-failed" : "status-idle";
      const runText = latestRun?.status === "passed" ? "通过" : latestRun?.status === "failed" ? "失败" : "未执行";
      return `<article class="case-row${item.id === currentSelectedCaseId ? " active" : ""}" data-case-id="${escapeHtml(item.id)}">
        <input class="case-select" type="checkbox" data-case-id="${escapeHtml(item.id)}" title="选择用例" />
        <div class="case-title">
          <span class="case-name">${escapeHtml(item.title)}</span>
          <span class="case-meta">${escapeHtml(item.module)} · ${escapeHtml(item.caseType)} · ${escapeHtml(String(dsl?.stepSummaries?.length ?? 0))} steps</span>
          <span class="case-row-tags">
            <span class="case-priority">${escapeHtml(item.priority)}</span>
            <span class="${dslClass}">${escapeHtml(dslState)}</span>
            <span class="status-tag ${runClass}">${escapeHtml(runText)}</span>
          </span>
          <button type="button" class="case-open-button" data-case-id="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.title)}"></button>
        </div>
      </article>`;
    })
    .join("");
  document.querySelectorAll(".case-select").forEach((input) => input.addEventListener("change", updateCaseActionState));
  document.querySelectorAll(".case-open-button").forEach((button) => {
    button.addEventListener("click", () => {
      currentSelectedCaseId = button.dataset.caseId || "";
      document.querySelectorAll(".case-row").forEach((row) => row.classList.remove("active"));
      button.closest(".case-row")?.classList.add("active");
    });
    button.addEventListener("click", () => renderCaseDetail(currentCaseAssets.find((item) => item.id === button.dataset.caseId)));
  });
  renderCaseDetail(cases.find((item) => item.id === currentSelectedCaseId) ?? cases[0]);
  renderCaseBatchStatus();
  updateCaseListFooter();
  updateCaseActionState();
}

function updateCaseListFooter() {
  const total = currentCaseAssets.length;
  const totalPages = Math.max(1, Math.ceil(total / CASE_PAGE_SIZE));
  const page = total === 0 ? 0 : Math.min(currentCasePage, totalPages);
  const busyText = currentCaseDslTrace?.status === "running"
    ? currentCaseDslTrace.statusText
    : currentCaseRunTrace?.status === "running"
      ? currentCaseRunTrace.statusText
      : "";
  if ($("caseStatusText")) $("caseStatusText").textContent = busyText || `共 ${total} 条 · 第 ${page}/${total === 0 ? 0 : totalPages} 页`;
  if ($("casePrevPage")) $("casePrevPage").disabled = page <= 1;
  if ($("caseNextPage")) $("caseNextPage").disabled = page >= totalPages;
}

function selectedCaseIds() {
  return [...document.querySelectorAll(".case-select:checked")].map((item) => item.dataset.caseId).filter(Boolean);
}

function updateCaseActionState() {
  const selected = selectedCaseIds();
  const selectedCases = currentCaseAssets.filter((item) => selected.includes(item.id));
  const dslGenerating = currentCaseDslTrace?.status === "running";
  const caseExecuting = currentCaseRunTrace?.status === "running";
  const selectAll = $("selectAllCases");
  if (selectAll) {
    const visible = [...document.querySelectorAll(".case-select")];
    const visibleSelected = visible.filter((item) => item.checked);
    selectAll.checked = visible.length > 0 && visibleSelected.length === visible.length;
    selectAll.indeterminate = visibleSelected.length > 0 && visibleSelected.length < visible.length;
  }
  if ($("generateCaseDsl")) $("generateCaseDsl").disabled = selected.length === 0 || dslGenerating || caseExecuting;
  if ($("pauseCaseDslGeneration")) $("pauseCaseDslGeneration").disabled = !dslGenerating || !currentCaseDslGenerationRunId || caseDslGenerationCancelInFlight;
  if ($("regenerateCaseDsl")) $("regenerateCaseDsl").disabled = selected.length === 0;
  if ($("executeCases")) $("executeCases").disabled = selected.length === 0 || dslGenerating || caseExecuting || selectedCases.some((item) => !item.latestDsl || !item.latestDsl.executable);
}

function renderCaseDetail(item) {
  if (!$("caseDetail")) return;
  if (!item) {
    $("caseDetail").innerHTML = `<div class="workbench-empty"><strong>请选择用例</strong><p>从左侧列表中选择用例查看详情。</p></div>`;
    return;
  }
  const dsl = item.latestDsl;
  const history = item.executionHistory ?? [];
  const latestRun = latestCaseRunForCurrentContext(item);
  const latestDslGenerationFailed = isLatestDslGenerationFailed(item?.latestDslGeneration);
  const dslState = dsl ? `${dsl.executable ? "可执行" : "不可执行"} / r${dsl.revision}` : "未生成";
  const runState = latestRun?.status === "passed" ? "通过" : latestRun?.status === "failed" ? "失败" : "未执行";
  const runClass = latestRun?.status === "passed" ? "status-passed" : latestRun?.status === "failed" ? "status-failed" : "status-idle";
  $("caseDetail").innerHTML = `
    <div class="case-detail-header">
      <div>
        <strong>${escapeHtml(item.title)}</strong>
        ${renderCaseBusinessSteps(item.businessRequest ?? item.request)}
        <div class="case-header-tags">
          <span class="case-priority">${escapeHtml(item.priority)}</span>
          <span class="${!dsl ? "case-dsl-missing" : !dsl.executable ? "case-dsl-gap" : "case-dsl-ready"}">${escapeHtml(dslState)}</span>
          <span class="status-tag ${runClass}">${escapeHtml(runState)}</span>
          <span class="status-tag status-idle">${escapeHtml(item.pageModelId ?? "未绑定页面")}</span>
        </div>
      </div>
      <div class="case-inspector-toolbar">
        <button type="button" class="detail-generate-dsl" data-case-id="${escapeHtml(item.id)}">生成 DSL</button>
        <button type="button" class="secondary-button detail-execute-case" data-case-id="${escapeHtml(item.id)}"${!dsl || !dsl.executable ? " disabled" : ""}>执行</button>
        <button type="button" class="secondary-button edit-case-button" data-case-id="${escapeHtml(item.id)}">编辑</button>
      </div>
    </div>
    <form class="case-edit-form" id="caseEditForm" data-case-id="${escapeHtml(item.id)}">
      <label>标题<input id="caseEditTitle" value="${escapeHtml(item.title)}" /></label>
      <label>模块<input id="caseEditModule" value="${escapeHtml(item.module)}" /></label>
      <label>等级
        <select id="caseEditPriority">
          ${["P0", "P1", "P2", "P3"].map((value) => `<option value="${value}"${item.priority === value ? " selected" : ""}>${value}</option>`).join("")}
        </select>
      </label>
      <label>用例类型<input id="caseEditCaseType" value="${escapeHtml(item.caseType)}" /></label>
      <label class="wide">业务步骤 / 需求描述<textarea id="caseEditBusinessRequest" rows="6">${escapeHtml(item.businessRequest ?? item.request ?? "")}</textarea></label>
      <label class="wide">前置条件<textarea id="caseEditPreconditions" rows="3">${escapeHtml((item.preconditions ?? []).join("\n"))}</textarea></label>
      <label class="wide">期望断言<textarea id="caseEditExpectedAssertion" rows="3">${escapeHtml(item.expectedAssertion ?? "")}</textarea></label>
      <label class="wide">UI 预期结果<textarea id="caseEditExpectedResultsUi" rows="3">${escapeHtml((item.expectedResults?.ui ?? []).join("\n"))}</textarea></label>
      <div class="case-edit-note">保存后该用例在所有项目下的旧 DSL 会清空，状态变为未生成。</div>
      <div class="button-row wide">
        <button type="button" id="saveCaseEdit">保存用例</button>
        <button type="button" class="secondary-button" id="cancelCaseEdit">取消</button>
      </div>
    </form>
    <div class="case-tabs" role="tablist">
      <button class="case-tab active" data-tab="run-trace">Run Trace</button>
      <button class="case-tab" data-tab="overview">Overview</button>
      <button class="case-tab" data-tab="preconditions">Preconditions</button>
      <button class="case-tab" data-tab="steps">Steps</button>
      <button class="case-tab" data-tab="assertions">Assertions</button>
      <button class="case-tab" data-tab="runs">Runs</button>
      <button class="case-tab" data-tab="ai">AI Notes</button>
    </div>
    <section class="case-tab-panel active" data-tab-panel="run-trace" id="caseRunTracePanel">
      ${renderCaseRunTrace(item)}
    </section>
    <section class="case-tab-panel" data-tab-panel="overview">
      <div class="assistant-badge-row">
        <span class="info-badge"><small>页面</small>${escapeHtml(item.pageModelId ?? "-")}</span>
        <span class="info-badge"><small>DSL</small>${escapeHtml(dslState)}</span>
        <span class="info-badge"><small>已有 DSL 项目</small>${escapeHtml((item.dslProjects ?? []).join(", ") || "-")}</span>
        <span class="info-badge"><small>账号</small>${latestDslGenerationFailed ? "未匹配" : renderAccountProfileInlineLink(dsl?.accountProfileDecision?.selectedAccount ?? "未匹配")}</span>
        <span class="info-badge"><small>画像</small>${escapeHtml(dsl?.accountProfileDecision?.status ?? "-")}</span>
      </div>
      <div class="case-overview-copy">${escapeHtml(item.expectedAssertion || "-")}</div>
      ${dsl?.accountProfileDecision ? `<details class="conversation-details"><summary>账号画像匹配</summary><div><pre>${escapeHtml(JSON.stringify(dsl.accountProfileDecision, null, 2))}</pre></div></details>` : ""}
      ${renderGapList(dsl?.gaps ?? [], "gap")}
      ${renderGapList(dsl?.blockingGaps ?? [], "blocking")}
    </section>
    <section class="case-tab-panel" data-tab-panel="preconditions">${renderPlainList(item.preconditions)}</section>
    <section class="case-tab-panel" data-tab-panel="steps">${renderCaseBusinessSteps(item.businessRequest ?? item.request)}${dsl?.stepSummaries?.length ? `<details class="conversation-details"><summary>DSL 步骤摘要</summary>${renderPlainList(dsl.stepSummaries)}</details>` : ""}</section>
    <section class="case-tab-panel" data-tab-panel="assertions">${renderPlainList(dsl?.assertionSummaries ?? [item.expectedAssertion].filter(Boolean))}</section>
    <section class="case-tab-panel" data-tab-panel="runs">${renderCaseExecutionHistory(history)}</section>
    <section class="case-tab-panel" data-tab-panel="ai">
      <details class="conversation-details" open><summary>DeepSeek / 本地规划明细</summary><div><pre>${escapeHtml(JSON.stringify(dsl?.deepseek ?? {}, null, 2))}</pre></div></details>
    </section>`;
  $("caseEditForm")?.classList.remove("active");
  document.querySelector(".edit-case-button")?.addEventListener("click", () => $("caseEditForm")?.classList.add("active"));
  $("cancelCaseEdit")?.addEventListener("click", () => $("caseEditForm")?.classList.remove("active"));
  $("saveCaseEdit")?.addEventListener("click", saveCurrentCaseEdit);
  document.querySelector(".detail-generate-dsl")?.addEventListener("click", () => runSingleCaseAction(item.id, "generate"));
  document.querySelector(".detail-execute-case")?.addEventListener("click", () => runSingleCaseAction(item.id, "execute"));
  document.querySelector(".case-dsl-retry")?.addEventListener("click", (event) => retryCaseDslGeneration(event.currentTarget?.dataset?.caseId, event.currentTarget?.dataset?.stage));
  bindAccountProfileJumpLinks($("caseDetail"));
  document.querySelectorAll(".case-tab").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".case-tab").forEach((tab) => tab.classList.remove("active"));
      document.querySelectorAll(".case-tab-panel").forEach((panel) => panel.classList.remove("active"));
      button.classList.add("active");
      document.querySelector(`.case-tab-panel[data-tab-panel="${button.dataset.tab}"]`)?.classList.add("active");
    });
  });
}

function runSingleCaseAction(caseId, action) {
  document.querySelectorAll(".case-select").forEach((item) => { item.checked = item.dataset.caseId === caseId; });
  currentSelectedCaseId = caseId;
  updateCaseActionState();
  if (action === "execute") return executeCaseBatch([caseId], "detail");
  return generateSelectedCaseDsl(false);
}

async function saveCurrentCaseEdit() {
  const form = $("caseEditForm");
  if (!form?.dataset.caseId) return;
  $("caseStatusText").textContent = "正在保存用例...";
  const result = await fetch("/api/cases/save", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project: $("project").value,
      caseId: form.dataset.caseId,
      patch: {
        title: $("caseEditTitle").value,
        module: $("caseEditModule").value,
        priority: $("caseEditPriority").value,
        caseType: $("caseEditCaseType").value,
        businessRequest: $("caseEditBusinessRequest").value,
        preconditions: $("caseEditPreconditions").value,
        expectedAssertion: $("caseEditExpectedAssertion").value,
        expectedResultsUi: $("caseEditExpectedResultsUi").value
      }
    })
  }).then((item) => item.json());
  $("caseStatusText").textContent = result.ok ? "用例已保存，DSL 已变为未生成。" : result.error || "保存失败。";
  await loadCases();
}

function renderPlainList(items) {
  if (!Array.isArray(items) || !items.length) return `<div class="empty-card">暂无。</div>`;
  return `<ul class="case-plain-list">${items.map((item) => `<li>${escapeHtml(readDisplayText(item))}</li>`).join("")}</ul>`;
}

function renderCaseBusinessSteps(value) {
  const steps = parseCaseBusinessSteps(value);
  if (!steps.length) return `<div class="empty-card">暂无业务步骤。</div>`;
  return `<ol class="case-business-steps">${steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>`;
}

function parseCaseBusinessSteps(value) {
  const text = String(value ?? "").trim();
  if (!text) return [];
  const lines = text
    .split(/\r?\n+/)
    .map((line) => line.replace(/^\s*\d+[.、)]\s*/, "").trim())
    .filter(Boolean);
  if (lines.length > 1) return lines;
  return text
    .split(/[；;。]\s*/)
    .map((item) => item.replace(/^\s*\d+[.、)]\s*/, "").trim())
    .filter(Boolean);
}

function readDisplayText(item) {
  if (item === null || item === undefined) return "";
  if (typeof item !== "object") return String(item);
  return String(item.name ?? item.semanticName ?? item.label ?? item.capabilityId ?? item.id ?? item.actionId ?? item.assertionId ?? item.type ?? JSON.stringify(item));
}

function renderCaseExecutionHistory(history) {
  if (!Array.isArray(history) || !history.length) return `<div class="workbench-empty"><strong>暂无执行记录</strong><p>执行后会显示时间、项目、环境、账号和断言详情。</p></div>`;
  return `<div class="compact-run-table"><table>
    <thead><tr><th>结果</th><th>时间</th><th>项目</th><th>环境</th><th>账号</th><th>断言 / 实际结果</th></tr></thead>
    <tbody>${history.map((item) => {
      const statusClass = item.status === "passed" ? "status-passed" : item.status === "failed" ? "status-failed" : "status-idle";
      const statusText = item.status === "passed" ? "通过" : item.status === "failed" ? "失败" : item.status;
      const assertions = Array.isArray(item.assertionSummaries) && item.assertionSummaries.length
        ? JSON.stringify(item.assertionSummaries, null, 2)
        : "本次没有断言摘要。";
      return `<tr>
        <td><span class="status-tag ${statusClass}">${escapeHtml(statusText)}</span></td>
        <td>${escapeHtml(formatDate(item.executedAt))}</td>
        <td>${escapeHtml(item.project ?? "-")}</td>
        <td>${escapeHtml(item.env ?? "-")}</td>
        <td>${renderAccountProfileInlineLink(item.account ?? "-")}</td>
        <td>
          <details class="inline-run-detail">
            <summary>${escapeHtml(item.actualResult || item.runId || "查看详情")}</summary>
            <pre>${escapeHtml(assertions)}</pre>
            ${item.accountProfileDecision ? `<pre>${escapeHtml(`accountProfile=${item.accountProfileDecision.status} ${item.accountProfileDecision.chineseSummary ?? ""}`)}</pre>` : ""}
            ${item.failurePackagePath || item.caseRunPath || item.observationArtifactPath || item.profileUpdatedPath ? `<pre>${escapeHtml([item.failurePackagePath ? `failurePackage=${item.failurePackagePath}` : "", item.caseRunPath ? `caseRun=${item.caseRunPath}` : "", item.observationArtifactPath ? `observation=${item.observationArtifactPath}` : "", item.profileUpdatedPath ? `profileUpdated=${item.profileUpdatedPath}` : ""].filter(Boolean).join("\n"))}</pre>` : ""}
          </details>
        </td>
      </tr>`;
    }).join("")}</tbody>
  </table></div>`;
}

function renderCaseRunTrace(item) {
  const dsl = item?.latestDsl;
  const activeTrace = currentCaseRunTrace?.caseIds?.includes(item?.id) ? currentCaseRunTrace : null;
  const liveDslTrace = currentCaseDslTrace?.caseIds?.includes(item?.id) ? currentCaseDslTrace : null;
  const persistedDslTrace = !liveDslTrace && shouldShowPersistedDslGeneration(item?.latestDslGeneration)
    ? latestDslGenerationToTrace(item.latestDslGeneration, item)
    : null;
  const activeDslTrace = liveDslTrace || persistedDslTrace;
  const isDslGenerating = activeDslTrace?.status === "running";
  const dslTraceItem = activeDslTrace?.items?.find((traceItem) => traceItem.caseId === item?.id);
  const suppressHistoryRun = Boolean(activeDslTrace) && !activeTrace;
  const suppressHistoryDuringActiveRun = activeTrace?.status === "running";
  const latestRun = isDslGenerating || suppressHistoryRun || suppressHistoryDuringActiveRun ? null : latestCaseRunForCurrentContext(item);
  const activeRunItem = activeTrace?.items?.find((traceItem) => traceItem.caseId === item?.id);
  const run = isDslGenerating || suppressHistoryRun || suppressHistoryDuringActiveRun
    ? activeTrace?.results?.find((result) => result.caseId === item?.id) ?? null
    : activeTrace?.results?.find((result) => result.caseId === item?.id) ?? latestRun;
  const accountText = activeDslTrace?.status === "failed" || activeDslTrace?.status === "cancelled"
    ? "-"
    : run?.account ?? dsl?.accountProfileDecision?.selectedAccount ?? "-";
  const displayStatus = activeDslTrace?.statusText ?? (dsl ? (activeTrace?.statusText ?? caseRunStatusText(run?.status ?? "idle")) : "当前 DSL 未生成");
  const mode = activeTrace?.status === "running"
    ? "running"
    : run
      ? "completed"
      : "planned";
  const completed = run?.status === "passed";
  const stepHtml = isDslGenerating
    ? `<div class="empty-card">正在生成 DSL，执行步骤将在生成完成后刷新。</div>`
    : dsl?.automationCase
    ? renderAssistantStepProgressHtml(dsl.automationCase.steps ?? [], {
      mode,
      completed,
      executionSteps: suppressHistoryDuringActiveRun ? activeRunItem?.executionSteps ?? [] : activeRunItem?.executionSteps ?? run?.executionSteps ?? []
    })
    : `<div class="empty-card">当前项目下还没有可执行 DSL。请先生成 DSL。</div>`;
  const assertionHtml = run
    ? renderAssertionSummariesReadable(run.assertionSummaries ?? [], dsl?.plan ?? {})
    : `<div class="empty-card">执行后会展示断言摘要；通过时保持简洁，失败时展开诊断。</div>`;
  const artifactHtml = run ? renderCaseExecutionArtifacts(run) : "";
  const dslProgressHtml = activeDslTrace
    ? `<details class="conversation-details" open><summary>DSL 生成进度</summary><div>${renderCaseDslStageProgressHtml(dslTraceItem?.stages ?? caseDslStageSkeleton(), dslTraceItem)}</div></details>`
    : "";
  return `<div class="case-run-trace">
    <div class="assistant-badge-row">
      <span class="info-badge"><small>状态</small>${escapeHtml(displayStatus)}</span>
      <span class="info-badge"><small>项目</small>${escapeHtml(selectedWorkbenchProject())}</span>
      <span class="info-badge"><small>环境</small>${escapeHtml(selectedWorkbenchEnv())}</span>
      <span class="info-badge"><small>账号</small>${renderAccountProfileInlineLink(accountText)}</span>
      <span class="info-badge"><small>DSL</small>${escapeHtml(dsl ? `r${dsl.revision}` : "未生成")}</span>
    </div>
    ${dslProgressHtml}
    <details class="conversation-details" open><summary>执行步骤进度</summary><div>${stepHtml}</div></details>
    <details class="conversation-details"${run?.status === "failed" ? " open" : ""}><summary>断言结果</summary><div>${assertionHtml}</div></details>
    ${artifactHtml}
  </div>`;
}

function shouldShowPersistedDslGeneration(summary) {
  if (!summary) return false;
  const status = String(summary.status ?? "").toLowerCase();
  return status === "failed" || status === "cancelled" || status === "running";
}

function isLatestDslGenerationFailed(summary) {
  return String(summary?.status ?? "").toLowerCase() === "failed";
}

function renderCaseDslStageProgressHtml(stages, traceItem) {
  const retryableStage = (stages ?? []).find((item) => item.retryable && item.status === "failed");
  const retryHtml = retryableStage
    ? `<div class="case-dsl-retry-row"><button type="button" class="secondary-button case-dsl-retry" data-case-id="${escapeHtml(traceItem?.caseId ?? currentSelectedCaseId)}" data-stage="${escapeHtml(retryableStage.failedStage ?? retryableStage.id)}">重试</button><span>${escapeHtml(retryableStage.detail ?? "可从失败阶段重试生成。")}</span></div>`
    : "";
  return `<ol class="assistant-step-progress-list planning-progress-list">${(stages ?? caseDslStageSkeleton()).map((item) => `<li class="${escapeHtml(item.status)}">
    <span class="step-progress-icon">${assistantStepProgressIcon(item.status)}</span>
    <div><strong>${escapeHtml(item.title)}</strong>${item.detail ? `<p>${escapeHtml(item.detail)}</p>` : ""}</div>
  </li>`).join("")}</ol>${retryHtml}`;
}

function latestDslGenerationToTrace(summary, item) {
  const normalizedStatus = String(summary?.status ?? "").toLowerCase();
  const status = normalizedStatus === "cancelled"
    ? "cancelled"
    : normalizedStatus === "completed"
      ? "completed"
      : normalizedStatus === "running"
        ? "running"
        : "failed";
  const stages = Array.isArray(summary?.stages) && summary.stages.length
    ? summary.stages
    : caseDslStageSkeleton();
  const retryableStage = stages.find((stage) => stage.retryable && stage.status === "failed");
  return {
    mode: "single",
    caseIds: [summary.caseId ?? item.id],
    runId: summary.runId,
    status,
    statusText: dslGenerationSummaryStatusText(summary),
    items: [{
      caseId: summary.caseId ?? item.id,
      title: item.title,
      status: status === "completed" ? "passed" : status,
      stages,
      retryable: Boolean(summary.retryable) || Boolean(retryableStage),
      failedStage: summary.failedStage ?? retryableStage?.failedStage ?? retryableStage?.id
    }],
    results: [summary]
  };
}

function dslGenerationSummaryStatusText(summary) {
  const status = String(summary?.status ?? "").toLowerCase();
  if (status === "completed") return summary?.executable === false ? "最近一次 DSL 生成完成但不可执行" : "最近一次 DSL 生成成功";
  if (status === "cancelled") return "最近一次 DSL 生成已停止";
  if (status === "running") return "最近一次 DSL 生成未完成";
  return summary?.retryable ? "最近一次 DSL 生成失败，可重试" : "最近一次 DSL 生成失败";
}

function renderCaseExecutionArtifacts(run) {
  const rows = [
    ["Run ID", run.runId],
    ["失败包", run.failurePackagePath],
    ["失败提示词", run.failurePromptPath],
    ["待审核知识更新", run.proposalPath],
    ["Case Run", run.caseRunPath],
    ["执行观测", run.observationArtifactPath]
  ].filter(([, value]) => value);
  if (!rows.length) return "";
  return conversationDetails("诊断产物", `<div class="artifact-link-list">${rows.map(([label, value]) => `<div><strong>${escapeHtml(label)}</strong><code>${escapeHtml(value)}</code></div>`).join("")}</div>`, run.status === "failed");
}

function renderCaseBatchStatus() {
  const node = $("caseBatchStatus");
  if (!node) return;
  const trace = currentCaseDslTrace?.mode === "batch" && currentCaseDslTrace.status === "running"
    ? currentCaseDslTrace
    : currentCaseRunTrace?.mode === "batch"
      ? currentCaseRunTrace
      : null;
  if (!trace) {
    node.classList.add("hidden");
    node.innerHTML = "";
    return;
  }
  const isDslTrace = trace === currentCaseDslTrace;
  const items = trace.items ?? [];
  const done = items.filter((item) => ["passed", "failed", "skipped", "cancelled"].includes(item.status)).length;
  const canCancelDslGeneration = isDslTrace && trace.status === "running";
  const canCancelExecution = !isDslTrace && trace.status === "running";
  node.classList.remove("hidden");
  node.innerHTML = `<div class="case-batch-head">
    <strong>${isDslTrace ? "批量生成 DSL" : "批量执行"}</strong>
    <span>${escapeHtml(done)} / ${escapeHtml(items.length)}</span>
    ${canCancelDslGeneration ? `<button type="button" class="secondary-button case-batch-cancel" id="cancelCaseDslGeneration" ${caseDslGenerationCancelInFlight ? "disabled" : ""}>停止生成</button>` : ""}
    ${canCancelExecution ? `<button type="button" class="secondary-button case-batch-cancel" id="cancelCaseBatchExecution" ${caseExecutionCancelInFlight ? "disabled" : ""}>终止执行</button>` : ""}
  </div>
  <div class="case-batch-list">${items.map((item) => `<button type="button" class="case-batch-item ${escapeHtml(item.status)}" data-case-id="${escapeHtml(item.caseId)}">
    <span>${escapeHtml(item.title)}</span>
    <small>${escapeHtml(caseRunStatusText(item.status))}</small>
  </button>`).join("")}</div>`;
  node.querySelector("#cancelCaseDslGeneration")?.addEventListener("click", cancelCaseDslGeneration);
  node.querySelector("#cancelCaseBatchExecution")?.addEventListener("click", cancelCaseBatchExecution);
  node.querySelectorAll(".case-batch-item").forEach((button) => {
    button.addEventListener("click", () => {
      currentSelectedCaseId = button.getAttribute("data-case-id") || currentSelectedCaseId;
      renderCases(currentCaseAssets);
    });
  });
}

function caseRunStatusText(status) {
  return {
    idle: "待执行",
    pending: "等待中",
    running: "执行中",
    completed: "完成",
    passed: "通过",
    failed: "失败",
    skipped: "跳过",
    cancelling: "停止中",
    cancelled: "已终止"
  }[status] ?? status ?? "未知";
}

function latestCaseRunForCurrentContext(item) {
  const project = selectedWorkbenchProject();
  const env = selectedWorkbenchEnv();
  return (item.executionHistory ?? []).find((run) => run.project === project && run.env === env);
}

function renderAssistantRunHistory(cases) {
  const list = $("assistantRunHistoryList");
  const status = $("assistantRunHistoryStatus");
  if (!list) return;
  const caseRecords = (Array.isArray(cases) ? cases : [])
    .flatMap((item) => (item.executionHistory ?? []).map((run) => ({
      ...run,
      caseTitle: item.title,
      demand: buildDisplayDemandForHistory(item),
      source: "case_center"
    })));
  const records = [...assistantRunHistoryRecords(), ...caseRecords]
    .sort((a, b) => new Date(b.executedAt ?? 0).getTime() - new Date(a.executedAt ?? 0).getTime())
    .slice(0, 30);
  if (status) status.textContent = records.length ? `${records.length} 条` : "暂无记录";
  if (!records.length) {
    list.innerHTML = `<div class="workbench-empty"><strong>暂无历史执行</strong><p>执行用例后会在这里展示需求、项目、环境、账号、时间和结果。</p></div>`;
    return;
  }
  list.innerHTML = records.map((item, index) => {
    const statusClass = item.status === "passed" ? "status-passed" : item.status === "failed" ? "status-failed" : "status-idle";
    const statusText = item.status === "passed" ? "通过" : item.status === "failed" ? "失败" : item.status ?? "未知";
    return `<article class="assistant-run-history-item">
      <button type="button" class="assistant-run-demand" data-run-history-index="${index}" title="${escapeHtml(item.demand || "点击填入需求")}">${escapeHtml(item.demand)}</button>
      <div class="assistant-run-meta">
        <span>${escapeHtml(item.project ?? "-")}</span>
        <span>${escapeHtml(item.env ?? "-")}</span>
        <span>${renderAccountProfileInlineLink(item.account ?? "-")}</span>
        <span>${escapeHtml(item.source === "assistant" ? "AI助手" : "用例中心")}</span>
      </div>
      <div class="assistant-run-footer">
        <time>${escapeHtml(formatDate(item.executedAt))}</time>
        <span class="status-tag ${statusClass}">${escapeHtml(statusText)}</span>
      </div>
    </article>`;
  }).join("");
  list.querySelectorAll(".assistant-run-demand").forEach((button) => {
    button.addEventListener("click", () => {
      const item = records[Number(button.dataset.runHistoryIndex)];
      if ($("assistantMessage")) $("assistantMessage").value = item?.demand ?? "";
      resetAssistantActionForInputChange();
    });
  });
  bindAccountProfileJumpLinks(list);
}

async function loadAssistantRunHistory() {
  if (!$("assistantRunHistoryList")) return;
  if (currentCaseAssets.length) {
    renderAssistantRunHistory(currentCaseAssets);
    return;
  }
  const project = encodeURIComponent(selectedWorkbenchProject());
  const env = encodeURIComponent(selectedWorkbenchEnv());
  const payload = await fetch(`/api/cases?project=${project}&env=${env}`).then((item) => item.json()).catch(() => ({ cases: [] }));
  renderAssistantRunHistory(payload.cases ?? []);
}

function assistantRunHistoryRecords() {
  try {
    const value = JSON.parse(localStorage.getItem("autoTestWorkbench.assistantRunHistory") || "[]");
    return Array.isArray(value) ? value.filter((item) => item && typeof item === "object").slice(0, 50) : [];
  } catch {
    return [];
  }
}

function saveAssistantRunHistoryRecord(result, passed) {
  const record = {
    source: "assistant",
    demand: $("assistantMessage")?.value?.trim() || "-",
    project: selectedWorkbenchProject(),
    env: selectedWorkbenchEnv(),
    account: extractAssistantRunAccount(result),
    executedAt: new Date().toISOString(),
    status: passed ? "passed" : "failed",
    runId: result?.runId,
    actualResult: result?.stderr || result?.stdout || result?.error || formatCommandResult(result ?? {})
  };
  const next = [record, ...assistantRunHistoryRecords()].slice(0, 50);
  localStorage.setItem("autoTestWorkbench.assistantRunHistory", JSON.stringify(next));
}

function extractAssistantRunAccount(result) {
  const text = [result?.stdout, result?.stderr, result?.actualResult].filter(Boolean).join("\n");
  return text.match(/^account=(.+)$/m)?.[1]?.trim() || result?.account || "-";
}

function buildDisplayDemandForHistory(item) {
  const businessRequest = item.businessRequest ?? item.request ?? item.title ?? "";
  const assertion = String(item.expectedAssertion ?? "").trim();
  return `${businessRequest}${assertion ? `，期望断言：${assertion}` : ""}`;
}

function selectedWorkbenchProject() {
  return $("project")?.value || $("assistantProject")?.value || ASSISTANT_DEFAULT_PROJECT;
}

function selectedWorkbenchEnv() {
  return $("env")?.value || $("assistantEnv")?.value || ASSISTANT_DEFAULT_ENV;
}

function renderAssistantContextButton() {
  const projectKey = selectedWorkbenchProject();
  const envKey = selectedWorkbenchEnv();
  const project = projectCatalog.find((item) => item.key === projectKey);
  const env = project?.envs?.find((item) => item.key === envKey);
  document.querySelectorAll("[data-context-project]").forEach((item) => { item.textContent = project?.name ?? projectKey; });
  document.querySelectorAll("[data-context-env]").forEach((item) => { item.textContent = env?.name ?? envKey; });
}

function openAssistantContextPopover() {
  assistantContextDraftProject = selectedWorkbenchProject();
  assistantContextDraftEnv = selectedWorkbenchEnv();
  renderAssistantContextChoices();
  $("assistantContextPopover")?.classList.toggle("hidden");
}

function renderAssistantContextChoices() {
  const projectList = $("assistantProjectChoices");
  const envList = $("assistantEnvChoices");
  if (!projectList || !envList) return;
  const selectedProject = assistantContextDraftProject || selectedWorkbenchProject();
  const selectedEnv = assistantContextDraftEnv || selectedWorkbenchEnv();
  projectList.innerHTML = projectCatalog
    .map((item) => `<button type="button" class="context-choice${item.key === selectedProject ? " active" : ""}" data-context-project-choice="${escapeHtml(item.key)}">${escapeHtml(item.name ?? item.key)}<small>${escapeHtml(item.key)}</small></button>`)
    .join("");
  const project = projectCatalog.find((item) => item.key === selectedProject) ?? projectCatalog[0];
  envList.innerHTML = (project?.envs ?? [])
    .map((item) => {
      const validation = validateWorkbenchEnv(item);
      return `<button type="button" class="context-choice${item.key === selectedEnv ? " active" : ""}${validation.ok ? "" : " invalid"}" data-context-env-choice="${escapeHtml(item.key)}" data-env-valid="${validation.ok ? "true" : "false"}" data-env-reason="${escapeHtml(validation.reason)}">${escapeHtml(item.name ?? item.key)}<small>${escapeHtml(item.key)}${validation.ok ? "" : ` · ${validation.reason}`}</small></button>`;
    })
    .join("");
  projectList.querySelectorAll("[data-context-project-choice]").forEach((button) => {
    button.addEventListener("click", () => {
      const projectKey = button.getAttribute("data-context-project-choice") || ASSISTANT_DEFAULT_PROJECT;
      assistantContextDraftProject = projectKey;
      const project = projectCatalog.find((item) => item.key === projectKey);
      assistantContextDraftEnv = project?.defaultEnv ?? project?.envs?.[0]?.key ?? ASSISTANT_DEFAULT_ENV;
      renderAssistantContextChoices();
    });
  });
  envList.querySelectorAll("[data-context-env-choice]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.getAttribute("data-env-valid") !== "true") {
        const reason = button.getAttribute("data-env-reason") || "环境信息不完整";
        showAssistantContextNotice(reason);
        return;
      }
      assistantContextDraftEnv = button.getAttribute("data-context-env-choice") || ASSISTANT_DEFAULT_ENV;
      applyAssistantContextPicker();
    });
  });
  showAssistantContextNotice("");
}

function applyAssistantContextPicker() {
  if ($("project")) $("project").value = assistantContextDraftProject || selectedWorkbenchProject();
  syncEnvOptions();
  if ($("env")) $("env").value = assistantContextDraftEnv || selectedWorkbenchEnv();
  syncWorkbenchCommandContext();
  resetAssistantActionForInputChange();
  $("assistantContextPopover")?.classList.add("hidden");
  refresh();
}

function validateWorkbenchEnv(env) {
  if (!env?.webBaseUrl || /\.example\.com/i.test(String(env.webBaseUrl))) return { ok: false, reason: "缺少真实 Web 地址" };
  return { ok: true, reason: "" };
}

function showAssistantContextNotice(message) {
  const node = $("assistantContextNotice");
  if (!node) return;
  node.textContent = message || "";
  node.classList.toggle("hidden", !message);
}

async function loadProjectKnowledgeMap() {
  if (!$("projectKnowledgeTree")) return;
  const project = encodeURIComponent($("project").value || "demo");
  $("projectKnowledgeTree").textContent = "正在加载项目知识地图...";
  const payload = await fetch(`/api/project-knowledge-map?project=${project}`).then((item) => item.json());
  currentProjectKnowledgeMap = payload;
  renderProjectKnowledgeMap(payload);
}

async function loadProjectCapabilities() {
  if (!$("projectCapabilitiesList")) return;
  const project = encodeURIComponent($("project")?.value || "demo");
  $("projectCapabilitiesList").innerHTML = `<div class="empty-card">正在加载项目能力。</div>`;
  try {
    const payload = await apiJson(`/api/project-capabilities?project=${project}`);
    currentProjectCapabilities = payload;
    renderProjectCapabilities(payload);
  } catch (error) {
    $("projectCapabilitiesSummary").innerHTML = "";
    $("projectCapabilitiesList").innerHTML = `<div class="empty-card">项目能力加载失败：${escapeHtml(error?.message ?? String(error))}</div>`;
  }
}

function renderProjectCapabilities(payload) {
  const capabilities = Array.isArray(payload?.capabilities) ? payload.capabilities : [];
  const warnings = Array.isArray(payload?.warnings) ? payload.warnings : [];
  $("projectCapabilitiesSummary").innerHTML = `
    <span class="info-badge"><small>项目</small>${escapeHtml(payload?.project ?? "-")}</span>
    <span class="info-badge"><small>索引</small>${payload?.exists ? "已配置" : "未配置"}</span>
    <span class="info-badge"><small>能力</small>${escapeHtml(capabilities.length)}</span>
    <span class="info-badge"><small>更新时间</small>${escapeHtml(formatDate(payload?.updatedAt))}</span>`;
  if (!payload?.exists) {
    $("projectCapabilitiesList").innerHTML = `<div class="empty-card">${escapeHtml(warnings[0] ?? "当前项目未配置能力索引。")}</div>`;
    return;
  }
  $("projectCapabilitiesList").innerHTML = capabilities.length
    ? capabilities.map(renderProjectCapabilityCard).join("")
    : `<div class="empty-card">当前项目能力索引为空。</div>`;
}

const CAPABILITY_TYPE_LABELS = {
  page_model: "页面模型",
  operation_manual: "操作手册",
  project_knowledge_map: "知识地图",
  case_asset: "用例资产",
  database_model: "数据库模型",
  account_profile: "账号画像",
  account_factory_adapter: "账号工厂",
  provider: "验证码/TOTP",
  project_workflow: "项目流程",
  modeling_script: "建模脚本",
  validation_script: "校验脚本",
  project_operation_guide: "操作指南"
};

const CAPABILITY_SCOPE_LABELS = {
  project_only: "仅本项目",
  project_env_only: "项目+环境",
  platform_generic: "平台通用",
  pattern_only: "仅作参考"
};

// 面向用户的中文说明（数据文件里的 handoffNotes 是给 AI/维护者的英文交接注记，不直接展示）。
const CAPABILITY_USER_NOTES = {
  "demo.page_model.store": "页面、元素、组件、定位与断言信号的执行级知识。",
  "demo.operation_manual.store": "页面能做什么、需要什么数据、操作后的业务效果。",
  "demo.project_knowledge_map": "项目结构与建模状态索引，用于查看哪些页面已建模。",
  "demo.case_assets": "用例设计与断言期望；生成的 DSL 与执行历史保存在本地运行态。",
  "demo.database_model": "已验证的多源数据库模型，支撑账号画像刷新。",
  "demo.account_profile": "账号画像可刷新用户/安全/KYC、资产与持仓维度。",
  "demo.account_factory.adapter": "支持自动注册账号、补齐 KYC、绑定谷歌验证、充值测试资金并刷新画像。",
  "demo.totp.keepassxc_notes_fallback": "支持从 KeePassXC 读取 6 位 TOTP 验证码。",
  "demo.account_management.ga_display": "账号列表不因 TOTP 未就绪而阻塞，按需懒加载。",
  "demo.finance_account.state_machine_capture": "理财账户状态机的受控建模脚本。",
  "demo.finance_account.write_completion_capture": "理财账户写入完成的受控样本采集。",
  "demo.finance_account.batch_and_switch_capture": "批量赎回弹窗与自动复投开关的采集脚本。",
  "demo.finance_account.batch_redeem_completion_capture": "批量赎回成功样本的受控采集。",
  "demo.personal_account.state_machine_capture": "个人中心账号状态采集。",
  "demo.asset_center.google_unbound_intercept_capture": "资产中心业务安全拦截页采集。",
  "demo.test_data_provisioning.fund_flows_guide": "资金流水测试数据的显式造数指南。",
  "demo.spot_fund_flow.remodel_capture": "现货流水页面的补充建模脚本。"
};

function renderProjectCapabilityCard(capability) {
  const entrypoints = Array.isArray(capability.entrypoints) ? capability.entrypoints : [];
  const assets = Array.isArray(capability.knowledgeAssets) ? capability.knowledgeAssets : [];
  const outputs = Array.isArray(capability.outputs) ? capability.outputs : [];
  const userNote = CAPABILITY_USER_NOTES[String(capability.capabilityId ?? "")] ?? "";
  return `
    <article class="project-capability-card">
      <div class="capability-card-head">
        <div>
          <strong>${escapeHtml(capability.name ?? capability.capabilityId ?? "-")}</strong>
          <span>${escapeHtml(capability.capabilityId ?? "-")}</span>
        </div>
        <span class="status-tag ${projectCapabilityStatusClass(capability.status)}">${escapeHtml(projectCapabilityStatusText(capability.status))}</span>
      </div>
      <div class="assistant-badge-row">
        <span class="info-badge"><small>类型</small>${escapeHtml(CAPABILITY_TYPE_LABELS[capability.type] ?? capability.type ?? "-")}</span>
        <span class="info-badge"><small>范围</small>${escapeHtml(CAPABILITY_SCOPE_LABELS[capability.reuseScope] ?? capability.reuseScope ?? "-")}</span>
        <span class="info-badge"><small>环境</small>${escapeHtml((capability.envs ?? []).join(", ") || "-")}</span>
      </div>
      <details class="conversation-details"><summary>入口</summary>${renderPlainList(entrypoints)}</details>
      <details class="conversation-details"><summary>知识资产</summary>${renderPlainList(assets)}</details>
      <details class="conversation-details"><summary>输出</summary>${renderPlainList(outputs)}</details>
      ${userNote ? `<p class="muted">${escapeHtml(userNote)}</p>` : ""}
    </article>`;
}

function projectCapabilityStatusClass(status) {
  if (status === "verified") return "status-passed";
  if (status === "candidate") return "knowledge-partial";
  if (status === "blocked" || status === "deprecated") return "status-failed";
  return "status-idle";
}

function projectCapabilityStatusText(status) {
  return {
    verified: "已验证",
    candidate: "候选",
    blocked: "阻断",
    deprecated: "废弃"
  }[status] ?? status ?? "未知";
}

function renderProjectKnowledgeMap(map) {
  const nodes = Array.isArray(map?.nodes) ? map.nodes : [];
  const summary = map?.summary ?? {};
  $("projectKnowledgeSummary").innerHTML = `
    <span class="info-badge"><small>项目</small>${escapeHtml(map?.project ?? "-")}</span>
    <span class="info-badge"><small>节点</small>${escapeHtml(summary.totalNodes ?? 0)}</span>
    <span class="info-badge"><small>已建模</small>${escapeHtml(summary.modeledNodes ?? 0)}</span>
    <span class="info-badge"><small>部分建模</small>${escapeHtml(summary.partialNodes ?? 0)}</span>
    <span class="info-badge"><small>更新时间</small>${escapeHtml(formatDate(map?.updatedAt))}</span>`;
  const childrenByParent = new Map();
  for (const node of normalizeProjectKnowledgeNodes(nodes)) {
    const parent = node.parentId || "__root__";
    if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
    childrenByParent.get(parent).push(node);
  }
  for (const [parent, children] of childrenByParent.entries()) childrenByParent.set(parent, sortKnowledgeTreeNodes(children));
  const roots = childrenByParent.get("__root__") ?? nodes.filter((item) => item.nodeType === "project");
  $("projectKnowledgeTree").innerHTML = renderKnowledgeTreeNodes(roots, childrenByParent, 0);
  document.querySelectorAll(".knowledge-node-button").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".knowledge-node-button").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      const node = nodes.find((item) => item.nodeId === button.dataset.nodeId);
      renderProjectKnowledgeDetail(node);
    });
  });
  document.querySelector(".knowledge-node-button")?.classList.add("active");
  renderProjectKnowledgeDetail(roots[0] ?? nodes[0]);
}

function normalizeProjectKnowledgeNodes(nodes) {
  return nodes;
}

function sortKnowledgeTreeNodes(nodes) {
  const typeOrder = { project: 0, module: 1, page: 2, dialog: 3, state: 4 };
  return [...nodes].sort((a, b) => {
    const orderA = typeOrder[a.nodeType] ?? 9;
    const orderB = typeOrder[b.nodeType] ?? 9;
    if (orderA !== orderB) return orderA - orderB;
    return String(a.label ?? "").localeCompare(String(b.label ?? ""), "zh-Hans-CN");
  });
}

function renderKnowledgeTreeNodes(nodes, childrenByParent, depth = 0) {
  if (!nodes.length) return `<div class="empty-card">暂无项目结构。</div>`;
  return `<ul>${nodes.map((node) => {
    const children = childrenByParent.get(node.nodeId) ?? [];
    const childCount = children.length ? `<span class="knowledge-child-count">${children.length}</span>` : "";
    return `<li class="knowledge-tree-item depth-${depth}">
      <button class="knowledge-node-button node-type-${escapeHtml(node.nodeType ?? "unknown")}" type="button" data-node-id="${escapeHtml(node.nodeId)}">
        <span class="knowledge-node-main">
          <span class="knowledge-node-type">${escapeHtml(knowledgeNodeTypeText(node.nodeType))}</span>
          <span class="knowledge-node-label">${escapeHtml(node.label)}</span>
        </span>
        <span class="knowledge-node-side">
          ${childCount}
          <span class="knowledge-status status-tag ${knowledgeStatusClass(node.modelingStatus)}">${escapeHtml(knowledgeStatusText(node.modelingStatus))}</span>
        </span>
      </button>
      ${children.length ? renderKnowledgeTreeNodes(children, childrenByParent, depth + 1) : ""}
    </li>`;
  }).join("")}</ul>`;
}

function renderProjectKnowledgeDetail(node) {
  if (!$("projectKnowledgeDetail")) return;
  if (!node) {
    $("projectKnowledgeDetail").innerHTML = `<div class="empty-card">请选择一个节点。</div>`;
    return;
  }
  $("projectKnowledgeDetail").innerHTML = `
    <div class="knowledge-detail-head">
      <div>
        <h3>${escapeHtml(node.label)}</h3>
        <p>${escapeHtml((node.path ?? []).join(" / "))}</p>
      </div>
      <span class="knowledge-status status-tag ${knowledgeStatusClass(node.modelingStatus)}">${escapeHtml(knowledgeStatusText(node.modelingStatus))}</span>
    </div>
    <div class="assistant-badge-row">
      <span class="info-badge"><small>类型</small>${escapeHtml(node.nodeType ?? "-")}</span>
      <span class="info-badge"><small>Page Model</small>${escapeHtml(node.pageModelId ?? "-")}</span>
      <span class="info-badge"><small>URL</small>${escapeHtml(node.urlPattern ?? "-")}</span>
      <span class="info-badge"><small>建模时间</small>${escapeHtml(node.modeledAt ? formatDate(node.modeledAt) : "-")}</span>
    </div>
    <div class="knowledge-detail-tabs">
      <details class="conversation-details" open><summary>页面功能描述</summary><div>${escapeHtml(node.description || node.pageDescription || "-")}</div></details>
      <details class="conversation-details" open><summary>导航路径</summary><div>${renderKnowledgePath(node.navigationPath ?? (node.path ?? []).slice(1))}</div></details>
      <details class="conversation-details" open><summary>页面能做什么</summary><div>${renderKnowledgeCapabilityList(node.capabilities ?? [])}</div></details>
      <details class="conversation-details" open><summary>元素</summary><div>${renderKnowledgeElementTable(node.elements ?? [])}</div></details>
      <details class="conversation-details"><summary>动作 / 跳转</summary><div>${renderKnowledgeActionTable(node.actions ?? [])}</div></details>
      <details class="conversation-details"><summary>可用断言能力</summary><div>${renderPlainList(node.assertions ?? [])}</div></details>
      <details class="conversation-details"><summary>建模备注</summary><div>${renderPlainList(node.notes ?? [])}</div></details>
    </div>`;
}

function renderKnowledgeElementTable(items) {
  if (!Array.isArray(items) || !items.length) return `<div class="empty-card">暂无元素摘要。</div>`;
  return `<div class="conversation-table"><table><thead><tr><th>元素</th><th>类型</th><th>字段</th><th>状态</th></tr></thead><tbody>${items.map((item) =>
    `<tr><td>${escapeHtml(item.name || item.elementId || "-")}</td><td>${escapeHtml(item.type || "-")}</td><td>${escapeHtml(item.targetField || "-")}</td><td>${escapeHtml(item.status || "-")}</td></tr>`
  ).join("")}</tbody></table></div>`;
}

function renderKnowledgePath(items) {
  const parts = Array.isArray(items) ? items.map((item) => String(item).trim()).filter(Boolean) : [];
  if (!parts.length) return `<div class="empty-card">暂无导航路径。</div>`;
  return `<div class="knowledge-path">${parts.map((item, index) => `
    <span class="knowledge-path-chip">${escapeHtml(item)}</span>
    ${index < parts.length - 1 ? `<span class="knowledge-path-separator">/</span>` : ""}
  `).join("")}</div>`;
}

function renderKnowledgeCapabilityList(items) {
  if (!Array.isArray(items) || !items.length) return `<div class="empty-card">暂无。</div>`;
  return `<ul class="case-plain-list knowledge-capability-list">${items.map((item) => {
    const capability = item && typeof item === "object" ? item : { name: String(item) };
    const title = capability.name || capability.capabilityId || capability.id || capability.flowId || "-";
    const meta = [capability.operationType, capability.status].filter(Boolean).join(" · ");
    return `<li><span>${escapeHtml(title)}</span>${meta ? `<small>${escapeHtml(meta)}</small>` : ""}</li>`;
  }).join("")}</ul>`;
}

function knowledgeNodeTypeText(type) {
  return {
    project: "项目",
    module: "分组",
    page: "页面",
    dialog: "弹窗",
    state: "状态"
  }[type] ?? "节点";
}

function renderKnowledgeActionTable(items) {
  if (!Array.isArray(items) || !items.length) return `<div class="empty-card">暂无动作摘要。</div>`;
  return `<div class="conversation-table"><table><thead><tr><th>动作</th><th>类型</th><th>目标页面</th><th>状态</th></tr></thead><tbody>${items.map((item) =>
    `<tr><td>${escapeHtml(item.name || item.actionId || "-")}</td><td>${escapeHtml(item.type || "-")}</td><td>${escapeHtml(item.targetPageId || "-")}</td><td>${escapeHtml(item.status || "-")}</td></tr>`
  ).join("")}</tbody></table></div>`;
}

function knowledgeStatusText(status) {
  return {
    modeled: "已建模",
    partial: "部分建模",
    unmodeled: "未建模",
    stale: "部分建模",
    unknown: "未知"
  }[status] ?? status ?? "未知";
}

function knowledgeStatusClass(status) {
  return {
    modeled: "knowledge-modeled",
    partial: "knowledge-partial",
    unmodeled: "knowledge-unmodeled",
    stale: "knowledge-partial",
    unknown: "knowledge-unknown"
  }[status] ?? "knowledge-unknown";
}

async function generateSelectedCaseDsl(force) {
  const caseIds = selectedCaseIds();
  if (!caseIds.length) {
    $("caseStatusText").textContent = "请先选择用例。";
    return;
  }
  const selectedCases = currentCaseAssets.filter((item) => caseIds.includes(item.id));
  const existingCases = selectedCases.filter((item) => item.latestDsl);
  let shouldForce = Boolean(force);
  if (!shouldForce && existingCases.length) {
    const confirmed = confirmCaseDslOverwrite(existingCases, selectedCases.length);
    if (!confirmed) {
      $("caseStatusText").textContent = "已取消生成 DSL。";
      return;
    }
    shouldForce = true;
  }
  $("caseStatusText").textContent = shouldForce ? "正在覆盖生成 DSL..." : "正在生成 DSL...";
  currentCaseRunTrace = null;
  currentCaseDslGenerationRunId = createClientRunId();
  caseDslGenerationCancelInFlight = false;
  currentCaseDslTrace = {
    mode: caseIds.length > 1 ? "batch" : "single",
    caseIds,
    runId: currentCaseDslGenerationRunId,
    status: "running",
    statusText: "正在生成 DSL",
    items: selectedCases.map((item) => ({ caseId: item.id, title: item.title, status: "pending", stages: caseDslStageSkeleton() })),
    results: []
  };
  currentSelectedCaseId = caseIds[0];
  renderCases(currentCaseAssets);
  const result = await fetchCaseDslGenerationStream({
    project: $("project").value,
    env: $("env").value,
    caseIds,
    runId: currentCaseDslGenerationRunId,
    force: shouldForce,
    onEvent: updateCaseDslGenerationEvent
  });
  $("caseStatusText").textContent = (result.results ?? []).map((item) => `${item.caseId}: ${item.ok ? `r${item.revision}` : item.error}`).join("；");
  const failed = (result.results ?? []).filter((item) => !item.ok || item.executable === false).length;
  const cancelled = (result.results ?? []).filter((item) => item.status === "cancelled").length;
  if (currentCaseDslTrace) {
    currentCaseDslTrace.status = failed ? "failed" : "completed";
    currentCaseDslTrace.statusText = cancelled
      ? `DSL 生成已停止，${cancelled} 条未继续生成`
      : failed
        ? `DSL 生成完成，${failed} 条存在 gap`
        : "DSL 生成完成";
    currentCaseDslTrace.results = result.results ?? [];
  }
  await loadCases();
  currentCaseDslGenerationRunId = "";
  caseDslGenerationCancelInFlight = false;
}

async function retryCaseDslGeneration(caseId, failedStage) {
  const targetCaseId = caseId || currentSelectedCaseId;
  if (!targetCaseId) return;
  const item = currentCaseAssets.find((candidate) => candidate.id === targetCaseId);
  if (!item) return;
  $("caseStatusText").textContent = "正在从失败阶段重试 DSL 生成...";
  currentCaseRunTrace = null;
  currentCaseDslGenerationRunId = createClientRunId();
  caseDslGenerationCancelInFlight = false;
  currentCaseDslTrace = {
    mode: "single",
    caseIds: [targetCaseId],
    runId: currentCaseDslGenerationRunId,
    status: "running",
    statusText: "正在从失败阶段重试 DSL 生成",
    items: [{ caseId: item.id, title: item.title, status: "running", stages: caseDslStageSkeleton() }],
    results: []
  };
  currentSelectedCaseId = targetCaseId;
  renderCases(currentCaseAssets);
  const result = await fetchCaseDslGenerationStream({
    project: $("project").value,
    env: $("env").value,
    caseIds: [targetCaseId],
    runId: currentCaseDslGenerationRunId,
    resumeFromStage: failedStage || "deepseek_intent_understanding",
    onEvent: updateCaseDslGenerationEvent
  });
  $("caseStatusText").textContent = (result.results ?? []).map((entry) => `${entry.caseId}: ${entry.ok ? `r${entry.revision}` : entry.error}`).join("；");
  const failed = (result.results ?? []).filter((entry) => !entry.ok || entry.executable === false).length;
  if (currentCaseDslTrace) {
    currentCaseDslTrace.status = failed ? "failed" : "completed";
    currentCaseDslTrace.statusText = failed ? "DSL 重试完成，仍存在 gap" : "DSL 重试完成";
    currentCaseDslTrace.results = result.results ?? [];
  }
  await loadCases();
  currentCaseDslGenerationRunId = "";
  caseDslGenerationCancelInFlight = false;
}

async function fetchCaseDslGenerationStream(input) {
  const response = await fetch("/api/cases/generate-dsl-stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: input.project, env: input.env, caseIds: input.caseIds, runId: input.runId, force: input.force, resumeFromStage: input.resumeFromStage })
  });
  if (!response.ok) throw new Error(`生成 DSL 请求失败：HTTP ${response.status}`);
  if (!response.body) return response.json();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";
    for (const chunk of chunks) {
      const line = chunk.split("\n").find((item) => item.startsWith("data: "));
      if (!line) continue;
      const event = JSON.parse(line.slice(6));
      input.onEvent?.(event);
      if (event.type === "complete") finalResult = event.result;
      if (event.type === "error") throw new Error(event.error || "生成 DSL 失败");
    }
  }
  if (!finalResult) throw new Error("生成 DSL 未返回最终结果。");
  return finalResult;
}

function updateCaseDslGenerationEvent(event) {
  if (!currentCaseDslTrace) return;
  if (event.type === "batch") {
    currentCaseDslTrace.statusText = event.detail || currentCaseDslTrace.statusText;
  }
  if (event.type === "heartbeat") {
    currentCaseDslTrace.statusText = event.detail || currentCaseDslTrace.statusText;
  }
  if (event.type === "case") {
    currentCaseDslTrace.items = (currentCaseDslTrace.items ?? []).map((item) =>
      item.caseId === event.caseId ? { ...item, status: normalizeCaseDslItemStatus(event.status), retryable: Boolean(event.result?.retryable) || item.retryable, failedStage: event.result?.failedStage ?? item.failedStage } : item
    );
    if (event.caseId) currentSelectedCaseId = event.caseId;
    if (event.result) {
      currentCaseDslTrace.results = [
        ...(currentCaseDslTrace.results ?? []).filter((item) => item.caseId !== event.caseId),
        event.result
      ];
    }
  }
  if (event.type === "stage") {
    currentCaseDslTrace.items = (currentCaseDslTrace.items ?? []).map((item) => {
      if (item.caseId !== event.caseId) return item;
      const stages = updateCaseDslStages(item.stages ?? caseDslStageSkeleton(), event);
      const status = stages.some((stage) => stage.status === "failed")
        ? "failed"
        : stages.every((stage) => ["completed", "skipped", "warning"].includes(stage.status))
          ? "passed"
          : "running";
      const retryableStage = stages.find((stage) => stage.retryable && stage.status === "failed");
      return { ...item, status, stages, retryable: Boolean(retryableStage), failedStage: retryableStage?.failedStage ?? item.failedStage };
    });
  }
  renderCases(currentCaseAssets);
}

function normalizeCaseDslItemStatus(status) {
  const value = String(status ?? "").toLowerCase();
  if (value === "cancelled" || value === "cancelling") return value;
  return normalizePlanningTraceStatus(status, "running");
}

function caseDslStageSkeleton() {
  return [
    { id: "load_case", title: "读取用例", detail: "等待读取用例正文、前置条件和断言。", status: "pending" },
    { id: "account_inventory_precheck", title: "账号池预检", detail: "等待加载当前项目/环境账号池；这里不做画像语义匹配。", status: "pending" },
    { id: "deepseek_intent_understanding", title: "AI 意图理解", detail: "等待 AI 解析业务目标和断言；失败会阻断 DSL 生成。", status: "pending" },
    { id: "project_knowledge_retrieval", title: "项目知识检索", detail: "等待检索 Page Model 和操作手册。", status: "pending" },
    { id: "dsl_materialization", title: "DSL 物化", detail: "等待本地把已验证项目知识物化为 AutomationCase。", status: "pending" },
    { id: "grounded_contract_validation", title: "生成内容可信度校验", detail: "等待校验生成内容是否引用真实项目知识。", status: "pending" },
    { id: "account_profile_match", title: "账号画像匹配", detail: "等待基于结构化账号要求匹配账号。", status: "pending" },
    { id: "deepseek_grounded_advisory", title: "AI 压缩审查", detail: "等待 AI 审查已物化 DSL；失败不阻断写入。", status: "pending" },
    { id: "dsl_contract_validation", title: "DSL 契约校验", detail: "等待校验断言、DSL 可执行性和 gap 分类。", status: "pending" },
    { id: "write_result", title: "写入结果", detail: "等待写入当前项目 DSL 或诊断。", status: "pending" }
  ];
}

function updateCaseDslStages(stages, event) {
  const next = [...stages];
  const eventId = normalizeCaseDslStageId(event.id ?? event.title);
  const index = next.findIndex((item) => item.id === eventId || item.title === event.title);
  const stage = {
    id: eventId,
    title: normalizeLegacyDslTerminology(String(event.title ?? eventId ?? "生成阶段")),
    detail: String(event.detail ?? ""),
    status: normalizePlanningTraceStatus(event.status, "running"),
    retryable: Boolean(event.retryable),
    failedStage: event.failedStage,
    attempt: event.attempt,
    maxAttempts: event.maxAttempts
  };
  if (index >= 0) next[index] = stage;
  else next.push(stage);
  return next;
}

function normalizeCaseDslStageId(value) {
  const raw = String(value ?? "").trim();
  const aliases = {
    intent_contract_validation: "grounded_contract_validation",
    "意图契约校验": "grounded_contract_validation",
    "生成内容可信度校验": "grounded_contract_validation"
  };
  return aliases[raw] ?? raw;
}

async function executeSelectedCases() {
  const caseIds = selectedCaseIds();
  if (!caseIds.length) {
    $("caseStatusText").textContent = "请先选择用例。";
    return;
  }
  return executeCaseBatch(caseIds, caseIds.length > 1 ? "batch" : "detail");
}

function confirmCaseDslOverwrite(existingCases, totalCount) {
  const project = selectedWorkbenchProject();
  if (totalCount === 1) {
    const item = existingCases[0];
    return window.confirm(`当前用例在项目 ${project} 下已存在 DSL ${item.latestDsl ? `r${item.latestDsl.revision}` : ""}。重新生成会覆盖当前项目下的 DSL，历史执行记录不会删除。是否继续？`);
  }
  return window.confirm(`已选择 ${totalCount} 条用例，其中 ${existingCases.length} 条在项目 ${project} 下已有 DSL。确认后会覆盖这些 DSL，未生成的用例会正常生成。是否继续？`);
}

async function executeCaseBatch(caseIds, source = "batch") {
  const selectedCases = currentCaseAssets.filter((item) => caseIds.includes(item.id));
  const blocked = selectedCases.filter((item) => !item.latestDsl || !item.latestDsl.executable);
  if (blocked.length) {
    $("caseStatusText").textContent = `有 ${blocked.length} 条用例没有可执行 DSL，不能执行。`;
    currentCaseRunTrace = {
      mode: source === "batch" ? "batch" : "single",
      caseIds,
      status: "failed",
      statusText: "存在不可执行用例",
      items: selectedCases.map((item) => ({ caseId: item.id, title: item.title, status: blocked.some((blockedItem) => blockedItem.id === item.id) ? "skipped" : "pending" })),
      results: blocked.map((item) => ({ caseId: item.id, status: "failed", actualResult: "当前项目下没有可执行 DSL。" }))
    };
    renderCases(currentCaseAssets);
    return;
  }
  const executeButton = $("executeCases");
  if (executeButton) executeButton.disabled = true;
  currentCaseExecutionRunId = createClientRunId();
  caseExecutionCancelInFlight = false;
  currentCaseRunTrace = {
    mode: source === "batch" ? "batch" : "single",
    caseIds,
    runId: currentCaseExecutionRunId,
    status: "running",
    statusText: "执行中",
    items: selectedCases.map((item) => ({ caseId: item.id, title: item.title, status: "pending" })),
    results: []
  };
  renderCases(currentCaseAssets);
  try {
    currentCaseRunTrace.items = selectedCases.map((item) => ({ caseId: item.id, title: item.title, status: "running" }));
    renderCases(currentCaseAssets);
    const result = await fetchCaseExecutionStream({
      project: $("project").value,
      env: $("env").value,
      caseIds,
      runId: currentCaseExecutionRunId,
      observationMode: Boolean($("caseObservationMode")?.checked),
      onEvent: updateCaseExecutionEvent
    });
    currentCaseRunTrace.results = (result.results ?? []).map((runResult) => ({ ...runResult, status: normalizeCaseExecutionResultStatus(runResult) }));
    currentCaseRunTrace.items = selectedCases.map((item) => {
      const runResult = currentCaseRunTrace.results.find((result) => result.caseId === item.id);
      const status = runResult?.status === "passed" ? "passed" : runResult?.status === "cancelled" ? "cancelled" : "failed";
      return { caseId: item.id, title: item.title, status };
    });
    await loadCases();
    const failed = currentCaseRunTrace.items.filter((item) => item.status === "failed").length;
    const cancelled = currentCaseRunTrace.items.filter((item) => item.status === "cancelled").length;
    currentCaseRunTrace.status = failed ? "failed" : "completed";
    currentCaseRunTrace.statusText = failed
      ? `执行完成，${failed} 条失败${cancelled ? `，${cancelled} 条已终止` : ""}`
      : cancelled
        ? `执行已终止，${cancelled} 条未继续执行`
        : "执行完成，全部通过";
    $("caseStatusText").textContent = currentCaseRunTrace.statusText;
    renderCases(currentCaseAssets);
  } finally {
    if (executeButton) executeButton.disabled = false;
    currentCaseExecutionRunId = "";
    caseExecutionCancelInFlight = false;
    updateCaseActionState();
  }
}

async function fetchCaseExecutionStream(input) {
  const response = await fetch("/api/cases/execute-stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: input.project, env: input.env, caseIds: input.caseIds, runId: input.runId, observationMode: input.observationMode })
  });
  if (!response.ok) throw new Error(`执行用例请求失败：HTTP ${response.status}`);
  if (!response.body) {
    return fetch("/api/cases/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: input.project, env: input.env, caseIds: input.caseIds, runId: input.runId, observationMode: input.observationMode })
    }).then((item) => item.json());
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";
    for (const chunk of chunks) {
      const line = chunk.split("\n").find((item) => item.startsWith("data: "));
      if (!line) continue;
      const event = JSON.parse(line.slice(6));
      input.onEvent?.(event);
      if (event.type === "complete") finalResult = event.result;
      if (event.type === "error") throw new Error(event.error || "执行用例失败");
    }
  }
  if (!finalResult) throw new Error("执行用例未返回最终结果。");
  return finalResult;
}

function updateCaseExecutionEvent(event) {
  if (!currentCaseRunTrace) return;
  if (event.type === "batch" || event.type === "heartbeat") {
    currentCaseRunTrace.statusText = event.detail || currentCaseRunTrace.statusText;
    $("caseStatusText").textContent = currentCaseRunTrace.statusText;
  }
  if (event.type === "step") {
    const caseId = event.caseId;
    currentCaseRunTrace.items = (currentCaseRunTrace.items ?? []).map((item) => {
      if (item.caseId !== caseId) return item;
      const executionSteps = upsertLiveExecutionStep(item.executionSteps ?? [], event);
      return { ...item, status: "running", executionSteps };
    });
    currentCaseRunTrace.statusText = readableExecutionStepEvent(event);
    $("caseStatusText").textContent = currentCaseRunTrace.statusText;
    if (caseId) currentSelectedCaseId = caseId;
  }
  renderCases(currentCaseAssets);
}

function upsertLiveExecutionStep(steps, event) {
  const dslStepId = String(event.dslStepId ?? event.step?.dsl_step_id ?? "");
  if (!dslStepId) return steps;
  const nextStep = {
    index: Number(event.stepIndex ?? event.step?.stepIndex ?? steps.length),
    stepId: event.step?.step_id,
    dslStepId,
    action: event.action ?? event.step?.action_type,
    target: event.target ?? event.step?.target_semantic_name,
    status: event.stepEventType === "step_start" ? "running" : event.status ?? event.step?.status,
    error: event.step?.error_message,
    durationMs: event.step?.duration_ms
  };
  const index = steps.findIndex((item) => String(item.dslStepId ?? item.dsl_step_id ?? item.id ?? "") === dslStepId);
  if (index < 0) return [...steps, nextStep].sort((left, right) => Number(left.index ?? 0) - Number(right.index ?? 0));
  const updated = [...steps];
  updated[index] = { ...updated[index], ...nextStep };
  return updated.sort((left, right) => Number(left.index ?? 0) - Number(right.index ?? 0));
}

function readableExecutionStepEvent(event) {
  const target = event.target || event.step?.target_semantic_name || event.dslStepId || "";
  if (event.stepEventType === "step_start") return `正在执行：${target}`;
  const status = event.status || event.step?.status || "";
  return `已执行：${target}${status ? `（${status}）` : ""}`;
}

function createClientRunId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `case-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeCaseExecutionResultStatus(runResult) {
  if (runResult?.status === "cancelled") return "cancelled";
  if (runResult?.ok) return runResult.status || "passed";
  return "failed";
}

async function cancelCaseDslGeneration() {
  if (!currentCaseDslGenerationRunId || !currentCaseDslTrace || caseDslGenerationCancelInFlight) return;
  caseDslGenerationCancelInFlight = true;
  currentCaseDslTrace.statusText = "正在停止批量生成 DSL...";
  currentCaseDslTrace.items = (currentCaseDslTrace.items ?? []).map((item) => item.status === "running" ? { ...item, status: "cancelling" } : item);
  $("caseStatusText").textContent = currentCaseDslTrace.statusText;
  renderCases(currentCaseAssets);
  try {
    await fetch("/api/cases/generate-dsl-cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: currentCaseDslGenerationRunId })
    });
  } catch (error) {
    $("caseStatusText").textContent = `停止请求发送失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

async function cancelCaseBatchExecution() {
  if (!currentCaseExecutionRunId || !currentCaseRunTrace || caseExecutionCancelInFlight) return;
  caseExecutionCancelInFlight = true;
  currentCaseRunTrace.statusText = "正在终止批量执行...";
  currentCaseRunTrace.items = (currentCaseRunTrace.items ?? []).map((item) => item.status === "running" ? { ...item, status: "cancelling" } : item);
  $("caseStatusText").textContent = currentCaseRunTrace.statusText;
  renderCases(currentCaseAssets);
  try {
    await fetch("/api/cases/execute-cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: currentCaseExecutionRunId })
    });
  } catch (error) {
    $("caseStatusText").textContent = `终止请求发送失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

function updateCaseBatchItemStatus(caseId, status, statusText) {
  if (!currentCaseRunTrace) return;
  currentCaseRunTrace.statusText = statusText || currentCaseRunTrace.statusText;
  currentCaseRunTrace.items = (currentCaseRunTrace.items ?? []).map((item) => item.caseId === caseId ? { ...item, status } : item);
  if (caseId) currentSelectedCaseId = caseId;
  renderCases(currentCaseAssets);
}

async function loadExecution() {
  if (!$("executionRunRows")) return;
  const project = encodeURIComponent($("project").value || "demo");
  const env = encodeURIComponent($("env").value || "test");
  const payload = await fetch(`/api/execution?project=${project}&env=${env}&limit=50`).then((item) => item.json());
  const summary = payload.aiSummary ?? {};
  $("execAiCalls").textContent = String(summary.invocations ?? 0);
  $("execAiTokens").textContent = String(summary.totalTokens ?? 0);
  $("execAiCost").textContent = `$${Number(summary.estimatedCost ?? 0).toFixed(6)}`;
  $("executionRunRows").innerHTML = (payload.runs ?? [])
    .map(
      (item) => `<tr>
        <td><code>${escapeHtml(String(item.run_id ?? "").slice(0, 8))}</code></td>
        <td>${escapeHtml(item.test_case_id ?? "")}</td>
        <td>${escapeHtml(item.mode ?? "")}</td>
        <td>${escapeHtml(item.status ?? "")}</td>
        <td>${escapeHtml(`${item.passed_steps ?? 0}/${item.total_steps ?? 0}`)}</td>
        <td>${escapeHtml(item.healed_steps ?? 0)}</td>
        <td>${escapeHtml(item.ai_invocation_count ?? 0)}</td>
        <td>${escapeHtml(item.duration_ms ?? 0)} ms</td>
      </tr>`
    )
    .join("");
  $("failureReportRows").innerHTML = (payload.failureReports ?? [])
    .map(
      (item) => `<tr>
        <td>${escapeHtml(item.case_id ?? "")}</td>
        <td>${escapeHtml(item.category ?? "")}</td>
        <td>${escapeHtml(item.failed_layer ?? "")}</td>
        <td>${escapeHtml(item.error_message ?? "")}</td>
        <td><code>${escapeHtml((item.attempted_locators ?? []).join("\\n"))}</code></td>
        <td><code>${escapeHtml(item.codex_prompt_path || item.codex_failure_package_path || "")}</code></td>
        <td>${escapeHtml(item.suggested_fix ?? "")}</td>
      </tr>`
    )
    .join("");
  $("aiUsageRows").innerHTML = (payload.aiUsages ?? [])
    .map(
      (item) => `<tr>
        <td>${formatDate(item.created_at)}</td>
        <td>${escapeHtml(item.model_name)}</td>
        <td>${escapeHtml(item.purpose)}</td>
        <td>${escapeHtml(item.total_tokens)}</td>
        <td>$${Number(item.estimated_cost ?? 0).toFixed(6)}</td>
        <td>${item.cache_hit ? "是" : "否"}</td>
      </tr>`
    )
    .join("");
}

async function startBootstrapScan(preflight = false) {
  $("bootstrapConsoleOutput").textContent = preflight ? "bootstrap_scan 扫描前检查中..." : "bootstrap_scan 执行中...";
  const response = await fetch("/api/actions/bootstrap-scan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project: $("project").value,
      env: $("env").value,
      platform: "web",
      startUrl: $("bootstrapStartUrl").value || $("webUrl")?.value,
      targetFlows: $("bootstrapTargetFlows").value,
      maxPages: $("bootstrapMaxPages").value,
      maxDepth: $("bootstrapMaxDepth").value,
      maxPaths: $("bootstrapMaxPaths").value,
      allowedDomains: $("bootstrapAllowedDomains").value,
      deniedPatterns: $("bootstrapDeniedPatterns").value,
      deniedActions: $("bootstrapDeniedActions").value,
      maxAiCalls: $("bootstrapMaxAiCalls").value,
      maxAiTokens: $("bootstrapMaxAiTokens").value,
      allowActions: $("bootstrapAllowActions").checked,
      headed: $("bootstrapHeaded").checked,
      loginRequired: $("bootstrapLoginRequired")?.checked,
      username: $("bootstrapUsername")?.value,
      password: $("bootstrapPassword")?.value,
      preflight
    })
  });
  const result = await response.json();
  $("bootstrapConsoleOutput").textContent = formatCommandResult(result);
  await refresh();
}

async function loadBootstrapScans() {
  if (!$("bootstrapScanRows")) return;
  const project = encodeURIComponent($("project").value || "demo");
  const env = encodeURIComponent($("env").value || "test");
  const payload = await fetch(`/api/bootstrap-scans?project=${project}&env=${env}&limit=50`).then((item) => item.json());
  const pagesByScan = groupCount(payload.pages ?? [], "scan_id");
  const pathsByScan = groupCount(payload.paths ?? [], "scan_id");
  const elementsByScan = groupCount(payload.elements ?? [], "scan_id");
  const dslByScan = {};
  for (const run of payload.runs ?? []) {
    dslByScan[run.scan_id] = (payload.dslCases ?? []).filter((item) => String(item.id ?? "").includes(String(run.scan_id ?? "").slice(0, 8))).length;
  }
  const replayByScan = {};
  for (const item of payload.paths ?? []) {
    const key = item.scan_id;
    replayByScan[key] ??= { passed: 0, total: 0 };
    replayByScan[key].total += 1;
    if (item.replay_status === "passed") replayByScan[key].passed += 1;
  }
  const packagesByScan = Object.fromEntries((payload.reviewPackages ?? []).map((item) => [item.scan_id, item]));
  $("bootstrapScanRows").innerHTML = (payload.runs ?? [])
    .map((item) => {
      const replay = replayByScan[item.scan_id] ?? { passed: 0, total: 0 };
      const reviewPackage = packagesByScan[item.scan_id];
      const coverage = (item.target_flow_coverage ?? [])
        .map((flow) => `${flow.flow}:${flow.matched_pages}/${flow.matched_paths}/${flow.matched_elements}`)
        .join(" ");
      return `<tr>
        <td><code>${escapeHtml(String(item.scan_id ?? "").slice(0, 8))}</code></td>
        <td>${escapeHtml(item.status ?? "")}</td>
        <td>${pagesByScan[item.scan_id] ?? item.visited_pages ?? 0}</td>
        <td>${pathsByScan[item.scan_id] ?? item.generated_paths ?? 0}</td>
        <td>${elementsByScan[item.scan_id] ?? item.generated_elements ?? 0}</td>
        <td>${dslByScan[item.scan_id] ?? item.generated_dsl_cases ?? 0}</td>
        <td>${replay.total ? `${replay.passed}/${replay.total}` : "pending"}</td>
        <td>${escapeHtml(coverage || "-")}</td>
        <td>${escapeHtml(`${item.ai_invocation_count ?? 0} / $${Number(item.estimated_cost ?? 0).toFixed(6)}`)}</td>
        <td>${escapeHtml(item.review_status ?? "pending")}</td>
        <td>${escapeHtml(item.promote_status ?? "pending")}</td>
        <td><code>${escapeHtml(reviewPackage?.prompt_md_path ?? reviewPackage?.package_path ?? "")}</code></td>
        <td class="button-cell">
          <button type="button" data-bootstrap-action="replay" data-scan-id="${escapeHtml(item.scan_id)}">Replay</button>
          <button type="button" data-bootstrap-action="approve" data-scan-id="${escapeHtml(item.scan_id)}">Approve</button>
          <button type="button" data-bootstrap-action="promote" data-scan-id="${escapeHtml(item.scan_id)}">Promote</button>
        </td>
      </tr>`;
    })
    .join("");
  document.querySelectorAll("[data-bootstrap-action]").forEach((button) => {
    button.addEventListener("click", () => runBootstrapAction(button.dataset.bootstrapAction, button.dataset.scanId));
  });
}

async function importBootstrapReview() {
  const scanId = $("bootstrapImportScanId").value.trim();
  const rawText = $("bootstrapReviewText").value.trim();
  if (!scanId || !rawText) {
    $("bootstrapConsoleOutput").textContent = "请填写 Scan ID，并粘贴人工/AI Review JSON/Markdown。";
    return;
  }
  $("bootstrapConsoleOutput").textContent = `import review ${scanId}...`;
  const response = await fetch("/api/bootstrap-scans/import-review", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project: $("project").value,
      env: $("env").value,
      scanId,
      rawText
    })
  });
  const result = await response.json();
  $("bootstrapConsoleOutput").textContent = JSON.stringify(result, null, 2);
  await refresh();
}

async function runBootstrapAction(action, scanId) {
  if (!action || !scanId) return;
  const path =
    action === "replay"
      ? "/api/bootstrap-scans/replay"
      : action === "approve"
        ? "/api/bootstrap-scans/approve"
        : "/api/bootstrap-scans/promote";
  $("bootstrapConsoleOutput").textContent = `${action} ${scanId}...`;
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: $("project").value, env: $("env").value, scanId })
  });
  const result = await response.json();
  $("bootstrapConsoleOutput").textContent = JSON.stringify(result, null, 2);
  await refresh();
}

function groupCount(rows, key) {
  return rows.reduce((acc, item) => {
    acc[item[key]] = (acc[item[key]] ?? 0) + 1;
    return acc;
  }, {});
}

function formatElementField(item) {
  return [
    item.inputType ? `type=${item.inputType}` : "",
    item.name ? `name=${item.name}` : "",
    item.placeholder ? `placeholder=${item.placeholder}` : ""
  ]
    .filter(Boolean)
    .join(" / ");
}

async function loadLogs() {
  if (!$("logRows")) return;
  const params = new URLSearchParams();
  if ($("logLevel").value) params.set("level", $("logLevel").value);
  if ($("logQuery").value) params.set("q", $("logQuery").value);
  params.set("limit", $("logLimit").value || "200");
  const payload = await fetch(`/api/logs?${params.toString()}`).then((item) => item.json());
  $("logRows").innerHTML = (payload.logs ?? [])
    .map(
      (item) => `<tr>
        <td>${formatDate(item.at)}</td>
        <td>${escapeHtml(item.level)}</td>
        <td>${escapeHtml(item.message)}</td>
        <td><pre class="inline-json">${escapeHtml(JSON.stringify(item.meta ?? {}, null, 2))}</pre></td>
      </tr>`
    )
    .join("");
}

async function searchKnowledge() {
  const project = encodeURIComponent($("project").value || "demo");
  const env = encodeURIComponent($("env").value || "test");
  const query = encodeURIComponent($("knowledgeQuery").value || "");
  const limit = encodeURIComponent($("knowledgeLimit").value || "20");
  const payload = await fetch(`/api/knowledge?project=${project}&env=${env}&q=${query}&limit=${limit}`).then((item) =>
    item.json()
  );
  renderKnowledge(payload.chunks ?? []);
}

async function loadProjects() {
  const payload = await fetch("/api/projects").then((item) => item.json());
  projectCatalog = payload.projects ?? [];
  $("project").innerHTML = projectCatalog
    .map((item) => `<option value="${escapeHtml(item.key)}">${escapeHtml(item.name)}</option>`)
    .join("");
  const preferred = projectCatalog.find((item) => item.key === "demo") ?? projectCatalog[0];
  if (preferred) $("project").value = preferred.key;
  syncEnvOptions();
  syncWorkbenchCommandContext();
  syncAccountProjectFilters();
  syncAccountFactoryProjectOptions();
  prefillExploreUrl();
}

function syncEnvOptions() {
  const project = currentProject();
  const envs = project?.envs ?? [];
  const previous = $("env").value;
  $("env").innerHTML = envs
    .map((item) => `<option value="${escapeHtml(item.key)}">${escapeHtml(item.name)}</option>`)
    .join("");
  $("env").value = envs.some((item) => item.key === previous) ? previous : project?.defaultEnv ?? envs[0]?.key ?? "test";
  syncAccountEnvFilters();
  syncAccountFactoryEnvOptions();
}

function syncAccountProjectFilters() {
  $("accountProjectFilter").innerHTML =
    `<option value="">全部</option>` +
    projectCatalog
    .map((item) => `<option value="${escapeHtml(item.key)}">${escapeHtml(item.name)}</option>`)
    .join("");
  $("accountProjectFilter").value = $("project").value;
  $("accountProjectFilter").addEventListener("change", () => {
    syncAccountEnvFilters();
    loadAccountProfiles();
  });
  $("accountEnvFilter").addEventListener("change", loadAccountProfiles);
  syncAccountEnvFilters();
}

function syncAccountEnvFilters() {
  const selectedProject = $("accountProjectFilter").value;
  if (!selectedProject) {
    $("accountEnvFilter").innerHTML = `<option value="">全部</option>`;
    $("accountEnvFilter").value = "";
    return;
  }
  const project = projectCatalog.find((item) => item.key === selectedProject) ?? currentProject();
  const envs = project?.envs ?? [];
  $("accountEnvFilter").innerHTML =
    `<option value="">全部</option>` +
    envs
    .map((item) => `<option value="${escapeHtml(item.key)}">${escapeHtml(item.name)}</option>`)
    .join("");
  $("accountEnvFilter").value = envs.some((item) => item.key === $("env").value) ? $("env").value : project?.defaultEnv ?? "";
}

function currentProject() {
  return projectCatalog.find((item) => item.key === $("project").value);
}

function currentEnv() {
  return currentProject()?.envs?.find((item) => item.key === $("env").value);
}

function prefillExploreUrl() {
  const env = currentEnv();
  if (!env) return;
  const url = $("webSurface").value === "spotAdmin" ? env.spotAdminBaseUrl : env.webBaseUrl;
  if (url) $("webUrl").value = url;
}

function renderResults(results) {
  $("resultRows").innerHTML = results
    .map(
      (item) => `<tr>
        <td>${escapeHtml(item.id)}</td>
        <td>${escapeHtml(item.status)}</td>
        <td>${item.durationMs ?? 0} ms</td>
        <td>${escapeHtml(item.aiReview?.nextAction ?? "")}</td>
      </tr>`
    )
    .join("");
}

function renderGraph(graph) {
  const nodesById = new Map((graph.nodes ?? []).map((item) => [item.pageId, item]));
  $("nodeRows").innerHTML = (graph.nodes ?? [])
    .map(
      (item) => `<tr>
        <td>${escapeHtml(item.semanticName ?? item.pageId)}</td>
        <td>${escapeHtml(item.platform)}</td>
        <td>${escapeHtml(surfaceName(item.surface))}</td>
        <td>${escapeHtml(item.url ?? "")}</td>
        <td>${item.elements?.length ?? 0}</td>
        <td>${Math.round((item.confidence ?? 0) * 100)}%</td>
      </tr>`
    )
    .join("");

  $("edgeRows").innerHTML = (graph.edges ?? [])
    .map((item) => {
      const from = nodesById.get(item.fromPageId)?.semanticName ?? item.fromPageId;
      const to = nodesById.get(item.toPageId)?.semanticName ?? item.toPageId;
      return `<tr>
        <td>${escapeHtml(from)}</td>
        <td>${escapeHtml(to)}</td>
        <td>${escapeHtml(surfaceName(item.surface))}</td>
        <td>${escapeHtml(item.action?.text || item.action?.href || item.action?.selector || item.action?.type)}</td>
        <td>${escapeHtml(item.riskLevel)}</td>
        <td>${item.successCount ?? 0}/${item.failedCount ?? 0}</td>
      </tr>`;
    })
    .join("");
}

function renderAppArchives(archive) {
  const latestExplorationByApk = new Map();
  for (const exploration of archive.explorations ?? []) {
    if (exploration.apkPath && !latestExplorationByApk.has(exploration.apkPath)) {
      latestExplorationByApk.set(exploration.apkPath, exploration);
    }
  }
  $("appArchiveRows").innerHTML = (archive.apps ?? [])
    .map((item) => {
      const exploration = latestExplorationByApk.get(item.filePath);
      return `<tr>
        <td><button type="button" class="link-button" data-apk="${escapeHtml(item.filePath)}">${escapeHtml(item.version || item.filename)}</button></td>
        <td>${formatDate(item.uploadedAt)}</td>
        <td>${formatBytes(item.sizeBytes)}</td>
        <td>${formatDate(exploration?.exploredAt)}</td>
        <td>${escapeHtml(exploration?.deviceId ?? "")}</td>
        <td>${exploration ? escapeHtml(String(exploration.exitCode)) : ""}</td>
      </tr>`;
    })
    .join("");
  document.querySelectorAll(".link-button[data-apk]").forEach((button) => {
    button.addEventListener("click", () => {
      $("apk").value = button.dataset.apk ?? "";
    });
  });
}

function renderKnowledge(chunks) {
  $("knowledgeRows").innerHTML = chunks
    .map(
      (item) => `<tr>
        <td>${escapeHtml(item.title)}</td>
        <td>${escapeHtml(item.sourceType)}</td>
        <td>${escapeHtml(surfaceName(item.surface))}</td>
        <td>${escapeHtml(item.content)}</td>
        <td>${Math.round((item.confidence ?? 0) * 100)}%</td>
      </tr>`
    )
    .join("");
}

function surfaceName(surface) {
  if (surface === "spotAdmin") return "现货后台";
  if (surface === "site") return "用户站点";
  if (surface === "mobileApp") return "App";
  return surface ?? "";
}

function formatCommandResult(result) {
  if (result.error) return result.error;
  return [`exitCode: ${result.exitCode}`, result.stdout, result.stderr].filter(Boolean).join("\n\n");
}

function planAssertionsFrom(plan) {
  if (!plan) return [];
  if (Array.isArray(plan.userAssertions)) return plan.userAssertions;
  if (Array.isArray(plan.pageModelExecutionPlan?.userAssertions)) return plan.pageModelExecutionPlan.userAssertions;
  return [];
}

function formatPlanAssertions(items) {
  if (!items.length) return "当前需求没有解析出用户断言；平台将只按步骤执行。";
  return items
    .map((item, index) => {
      const intent = item.assertionIntent ?? {};
      const lines = [
        `#${index + 1}`,
        `原文：${item.rawText ?? ""}`,
        `断言类型：${item.kind ?? ""}`,
        intent.targetPage ? `目标页面：${intent.targetPage}` : "",
        intent.targetObject ? `目标对象：${intent.targetObject}` : "",
        intent.field ? `字段/列：${intent.field}` : "",
        intent.operator ? `判断方式：${intent.operator}` : "",
        intent.expected !== undefined ? `期望值：${JSON.stringify(intent.expected)}` : formatExpectedTexts(item.expectedTexts),
        `允许空状态：${Boolean(item.acceptsEmptyState || intent.emptyStateAccepted)}`,
        item.confidence !== undefined ? `置信度：${Math.round(Number(item.confidence) * 100)}%` : "",
        intent.source ? `解析来源：${intent.source}` : "",
        item.mappedEvidence?.length ? `映射证据：${item.mappedEvidence.map((evidence) => evidence.id).join(", ")}` : "映射证据：无"
      ].filter(Boolean);
      return lines.join("\n");
    })
    .join("\n\n");
}

function formatExpectedTexts(values) {
  return Array.isArray(values) && values.length ? `期望文本：${values.map((value) => JSON.stringify(value)).join(", ")}` : "";
}

function formatAssertionSummaries(items) {
  if (!items.length) return "本次执行没有用户断言步骤。";
  return items
    .map((item, index) => {
      const understood = [
        `#${index + 1}`,
        item.type ? `断言类型：${item.type}` : "",
        item.table ? `表：${item.table}` : "",
        item.column ? `字段/列：${item.column}` : "",
        item.expected !== undefined ? `期望值：${JSON.stringify(item.expected)}` : "",
        item.emptyStateAccepted !== undefined ? `允许空状态：${Boolean(item.emptyStateAccepted)}` : ""
      ].filter(Boolean).join("\n");
      const actual = item.actual !== undefined ? `实际观测：${JSON.stringify(item.actual)}` : "";
      const error = item.error ? `失败原因：${item.error}` : "";
      return [understood, `结果：${item.status}`, actual, error].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

async function sendAssistantMessageV2() {
  const message = $("assistantMessage").value.trim();
  if (!message) {
    $("assistantStatus").textContent = "请先输入需求。";
    return;
  }

  $("assistantPlan").textContent = "正在生成...";
  $("assistantPlanOverview").innerHTML = "正在理解需求...";
  $("assistantAssertionUnderstanding").innerHTML = "正在解析断言...";
  $("assistantAssertionResults").innerHTML = "等待执行。";
  $("assistantKnowledgeRows").innerHTML = "";
  const stopProgress = startAssistantProgress();
  try {
    const response = await fetch("/api/assistant/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project: $("project")?.value || ASSISTANT_DEFAULT_PROJECT,
        env: $("env")?.value || ASSISTANT_DEFAULT_ENV,
        message
      })
    });
    const result = await response.json();
    stopProgress();
    if (result.error) {
      $("assistantStatus").textContent = result.error;
      $("assistantPlan").textContent = result.error;
      return;
    }
    $("assistantStatus").textContent = `已生成计划：${result.usedModel}`;
    renderAssistantTrace(result.trace ?? []);
    currentAssistantPlan = result.plan ?? null;
    $("assistantPlanOverview").innerHTML = renderAssistantPlanOverview(result.plan);
    $("assistantAssertionUnderstanding").innerHTML = renderPlanAssertionsReadable(planAssertionsFrom(result.plan), result.plan);
    $("assistantAssertionResults").innerHTML = renderAssertionSummariesReadable([], result.plan);
    $("assistantPlan").textContent = JSON.stringify(result.plan ?? {}, null, 2);
    renderAssistantKnowledge(result.knowledgeHits ?? []);
  } catch (error) {
    stopProgress();
    const message = error instanceof Error ? error.message : String(error);
    $("assistantStatus").textContent = message;
    $("assistantPlan").textContent = message;
  }
}

async function executeAssistantPlanV2(confirmWrite = false) {
  if (!currentAssistantPlan) {
    $("assistantStatus").textContent = "请先生成执行计划。";
    return;
  }
  if (currentAssistantPlan.requiresConfirmation && !confirmWrite) {
    $("confirmPlanText").textContent = `当前计划需要确认后执行。任务：${currentAssistantPlan.intent ?? ""}`;
    $("confirmPlanModal").classList.remove("hidden");
    return;
  }
  $("assistantStatus").textContent = "正在执行当前计划...";
  $("assistantExecute").disabled = true;
  renderAssistantTrace([
    {
      step: "执行计划",
      detail: "请求后端执行器，浏览器任务执行期间请等待返回结果。",
      status: "running",
      at: new Date().toISOString()
    }
  ]);
  try {
    const response = await fetch("/api/assistant/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project: $("project")?.value || ASSISTANT_DEFAULT_PROJECT,
        env: $("env")?.value || ASSISTANT_DEFAULT_ENV,
        message: $("assistantMessage").value,
        plan: currentAssistantPlan,
        confirmWrite
      })
    });
    const result = await response.json();
    const completed = result.exitCode === 0;
    $("assistantPlanOverview").innerHTML = renderAssistantPlanOverview(currentAssistantPlan);
    $("assistantAssertionUnderstanding").innerHTML = renderPlanAssertionsReadable(planAssertionsFrom(currentAssistantPlan), currentAssistantPlan);
    $("assistantAssertionResults").innerHTML = renderAssertionSummariesReadable(result.assertionSummaries ?? [], currentAssistantPlan);
    $("assistantStatus").textContent = completed ? "计划执行完成。" : "计划执行未完成。";
    renderAssistantTrace([
      {
        step: "执行计划",
        detail: completed ? "后端执行器返回成功。" : `后端执行器返回 exitCode=${result.exitCode}。`,
        status: completed ? "completed" : "failed",
        at: new Date().toISOString()
      }
    ]);
    $("assistantPlan").textContent = [
      JSON.stringify(currentAssistantPlan, null, 2),
      "",
      "--- 执行输出 ---",
      formatCommandResult(result)
    ].join("\n");
    await refresh();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    $("assistantStatus").textContent = "执行请求失败。";
    renderAssistantTrace([
      {
        step: "执行计划",
        detail: message,
        status: "failed",
        at: new Date().toISOString()
      }
    ]);
    $("assistantPlan").textContent = `${JSON.stringify(currentAssistantPlan, null, 2)}\n\n--- 执行异常 ---\n${message}`;
  } finally {
    $("assistantExecute").disabled = false;
  }
}

function renderAssistantPlanOverview(plan) {
  if (!plan) return "\u7b49\u5f85\u751f\u6210\u3002";
  const executionPlan = plan.pageModelExecutionPlan ?? {};
  const intent = plan.intentSpec ?? executionPlan.selection?.intent ?? {};
  const steps = automationStepsFrom(plan);
  const evidence = evidenceSummaryFromPlan(plan);
  const badges = [
    ["\u6a21\u5757", intent.module ?? "-"],
    ["\u52a8\u4f5c", intent.action ?? plan.intent ?? "-"],
    ["\u7c7b\u578b", intent.operationType ?? "-"],
    ["readiness", plan.readiness ?? executionPlan.readiness ?? "-"],
    ["executable", String(Boolean(plan.executable ?? executionPlan.executable))],
    ["selectedEvidence", String(evidence.selected.length)],
    ["fallbackEvidence", String(evidence.fallback.length)]
  ];
  return `
    <div class="assistant-badge-row">${badges.map(([label, value]) => `<span class="info-badge"><small>${escapeHtml(label)}</small>${escapeHtml(value)}</span>`).join("")}</div>
    <div class="assistant-step-summary">
      <strong>AutomationCase \u6b65\u9aa4\uff1a${steps.length}</strong>
      <p>${escapeHtml(plan.recommendedNextAction ? `\u5efa\u8bae\u52a8\u4f5c\uff1a${plan.recommendedNextAction}` : "\u5df2\u751f\u6210\u6267\u884c\u8349\u6848\u3002")}</p>
      ${renderAutomationStepsReadable(steps)}
      ${renderGapList(plan.gaps ?? executionPlan.gaps ?? [], "gap")}
      ${renderGapList(plan.blockingGaps ?? executionPlan.blockingGaps ?? [], "blocking")}
    </div>`;
}

function renderAutomationStepsReadable(steps, mode = "planned") {
  if (!Array.isArray(steps) || !steps.length) {
    return `<div class="empty-card">\u5c1a\u672a\u751f\u6210\u53ef\u5c55\u793a\u7684\u6267\u884c\u6b65\u9aa4\u3002</div>`;
  }
  return `<ol class="automation-check-list">${steps
    .map((step, index) => {
      const target = step.semanticTarget ?? step.semantic_target ?? step.target ?? step.elementId ?? step.assertionId ?? step.evidenceId ?? "-";
      const refs = [
        step.pageModelId ? `pageModelId: ${step.pageModelId}` : "",
        step.elementId ? `elementId: ${step.elementId}` : "",
        step.actionResultId ? `actionResultId: ${step.actionResultId}` : "",
        step.assertionId ? `assertionId: ${step.assertionId}` : "",
        step.evidenceId ? `evidenceId: ${step.evidenceId}` : "",
        step.source ? `source: ${step.source}` : ""
      ].filter(Boolean);
      const line = readableStepLine(step, target);
      const assertion = step.assertion?.column
        ? `\u65ad\u8a00\u5217=${step.assertion.column}\uff0c\u671f\u671b=${JSON.stringify(step.assertion.expected ?? "")}`
        : "";
      return `<li>
        <span class="step-check">${escapeHtml(stepCheckSymbol(mode, step))}</span>
        <span class="step-number">${String(index + 1).padStart(2, "0")}</span>
        <div class="step-readable">
          <strong>${escapeHtml(line)}</strong>
          ${assertion ? `<p>${escapeHtml(assertion)}</p>` : ""}
          ${refs.length ? `<details class="step-tech"><summary>\u6280\u672f\u8be6\u60c5</summary><pre>${escapeHtml(refs.join("\n"))}</pre></details>` : ""}
        </div>
      </li>`;
    })
    .join("")}</ol>`;
}

function renderAssistantStepProgress(plan, options = {}) {
  const steps = automationStepsFrom(plan);
  const html = renderAssistantStepProgressHtml(steps, options);
  updateAssistantConversationMessage("assistantStepProgressMessage", "执行步骤", html, {
    badge: options.mode === "completed" ? (options.completed ? "passed" : "failed") : options.mode === "running" ? "running" : "ready",
    status: options.mode === "completed" ? (options.completed ? "completed" : "failed") : options.mode === "running" ? "running" : "completed"
  });
}

function startAssistantExecutionStepProgress(plan) {
  if (assistantStepProgressTimer) window.clearInterval(assistantStepProgressTimer);
  renderAssistantStepProgress(plan, { mode: "running", runningIndex: 0 });
  return () => {
    if (assistantStepProgressTimer) window.clearInterval(assistantStepProgressTimer);
    assistantStepProgressTimer = null;
  };
}

function startAssistantExecutionStepPolling(plan, startedAtMs) {
  if (assistantStepProgressTimer) window.clearInterval(assistantStepProgressTimer);
  let activeRunId = "";
  renderAssistantStepProgress(plan, { mode: "running", runningIndex: 0 });
  const poll = async () => {
    try {
      const project = encodeURIComponent(selectedWorkbenchProject());
      const env = encodeURIComponent(selectedWorkbenchEnv());
      const payload = await fetch(`/api/execution?project=${project}&env=${env}&limit=8`).then((item) => item.json());
      const runs = Array.isArray(payload.runs) ? payload.runs : [];
      const candidate = activeRunId
        ? runs.find((run) => run.run_id === activeRunId)
        : runs.find((run) => new Date(run.start_time ?? 0).getTime() >= startedAtMs - 1000);
      if (!candidate) return;
      activeRunId = candidate.run_id;
      const executionSteps = (Array.isArray(payload.steps) ? payload.steps : [])
        .filter((step) => step.run_id === activeRunId)
        .map((step, index) => ({
          index,
          dslStepId: step.dsl_step_id,
          action: step.action_type,
          target: step.target_semantic_name,
          status: step.status,
          error: step.error_message
        }))
        .reverse();
      const finishedSteps = executionSteps.filter((step) => ["passed", "failed", "healed"].includes(String(step.status ?? "").toLowerCase())).length;
      renderAssistantStepProgress(plan, {
        mode: candidate.end_time ? "completed" : "running",
        completed: candidate.status === "passed",
        runningIndex: Math.min(finishedSteps, Math.max(0, automationStepsFrom(plan).length - 1)),
        executionSteps
      });
    } catch {
      // Polling is best-effort. The final execution response remains authoritative.
    }
  };
  poll();
  assistantStepProgressTimer = window.setInterval(poll, 900);
  return () => {
    if (assistantStepProgressTimer) window.clearInterval(assistantStepProgressTimer);
    assistantStepProgressTimer = null;
  };
}

function renderAssistantStepProgressHtml(steps, options = {}) {
  if (!Array.isArray(steps) || !steps.length) {
    return `<div class="empty-card">当前计划没有可展示的执行步骤。</div>`;
  }
  const executionSteps = Array.isArray(options.executionSteps) ? options.executionSteps : [];
  const executionByDslId = new Map(executionSteps.map((item) => [String(item.dslStepId ?? item.dsl_step_id ?? item.id ?? ""), item]));
  const unmatchedExecutionSteps = executionSteps.filter((item) => {
    const id = String(item.dslStepId ?? item.dsl_step_id ?? item.id ?? "");
    return id && !steps.some((step) => String(step.id ?? step.dslStepId ?? "") === id);
  });
  const syncNote = options.mode === "running" && !executionSteps.length
    ? `<p class="step-progress-note">执行器运行中，等待后端步骤状态回传；当前不会按定时器模拟跳步。</p>`
    : "";
  const mismatchNote = unmatchedExecutionSteps.length
    ? `<details class="conversation-details"><summary>实际执行包含 ${escapeHtml(String(unmatchedExecutionSteps.length))} 个额外步骤</summary>${renderPlainList(unmatchedExecutionSteps.map((step) => `${step.action ?? "-"} ${step.target ?? step.dslStepId ?? step.id ?? ""} ${step.status ?? ""}`))}</details>`
    : "";
  return `${syncNote}<ol class="assistant-step-progress-list">${steps.map((step, index) => {
    const execution = executionByDslId.get(String(step.id ?? step.dslStepId ?? ""));
    const status = assistantStepProgressStatus(step, index, options, execution);
    const target = step.semanticTarget ?? step.semantic_target ?? step.target ?? step.elementId ?? step.assertionId ?? step.evidenceId ?? "-";
    return `<li class="${escapeHtml(status)}">
      <span class="step-progress-icon">${assistantStepProgressIcon(status)}</span>
      <div>
        <strong>${escapeHtml(readableStepLine(step, target))}</strong>
        ${execution?.error || execution?.errorMessage ? `<p>${escapeHtml(execution.error ?? execution.errorMessage)}</p>` : ""}
      </div>
    </li>`;
  }).join("")}</ol>${mismatchNote}`;
}

function assistantStepProgressStatus(step, index, options, execution) {
  const mode = options.mode ?? "planned";
  const executionStatus = String(execution?.status ?? "").toLowerCase();
  if (executionStatus === "passed" || executionStatus === "healed") return "completed";
  if (executionStatus === "failed") return "failed";
  if (mode === "completed") return options.completed ? "completed" : index === 0 ? "failed" : "pending";
  if (mode === "running") {
    const runningIndex = Number(options.runningIndex ?? 0);
    if (index < runningIndex) return "completed";
    if (index === runningIndex) return "running";
    return "pending";
  }
  return "pending";
}

function assistantStepProgressIcon(status) {
  if (status === "completed") return "✓";
  if (status === "warning") return "!";
  if (status === "failed") return "×";
  if (status === "running") return "";
  return "";
}

function stepCheckSymbol(mode, step) {
  const status = String(step.status ?? step.result ?? "").toLowerCase();
  if (status === "passed" || status === "pass" || status === "completed") return "\u2713";
  if (status === "failed" || status === "fail" || status === "error") return "\u00d7";
  if (mode === "running") return "...";
  return " ";
}

function readableStepLine(step, target) {
  const action = step.action;
  const value = step.value ?? step.input ?? step.assertion?.expected;
  const text = String(target ?? "-");
  if (action === "navigate") return `\u6253\u5f00 ${cleanStepTarget(text)}\u9875\u9762`;
  if (action === "click") return `\u70b9\u51fb ${cleanStepTarget(text)}`;
  if (action === "select") return `\u9009\u62e9 ${cleanStepTarget(text)}${value !== undefined ? `\uff1a${displayStepValue(value)}` : ""}`;
  if (action === "input") return `\u8f93\u5165 ${cleanStepTarget(text)}${value !== undefined ? `\uff1a${displayStepValue(value)}` : ""}`;
  if (action === "assert") return readableAssertionStepLine(step, text);
  if (action === "provider") return `\u83b7\u53d6\u9a8c\u8bc1\u7801\uff1a${cleanStepTarget(text)}`;
  if (action === "confirmWrite") return `\u786e\u8ba4\u63d0\u4ea4\uff1a${cleanStepTarget(text)}`;
  if (action === "wait") return `\u7b49\u5f85 ${cleanStepTarget(text)}`;
  return `${actionReadableLabel(action)} ${cleanStepTarget(text)}`.trim();
}

function readableAssertionStepLine(step, fallbackTarget) {
  const assertion = step.assertion ?? {};
  const column = assertion.column ?? assertion.intent?.field;
  const expected = assertion.expected ?? assertion.intent?.expected;
  if (column && expected !== undefined) return `\u65ad\u8a00\uff1a${column}\u5217\u4ec5\u8fd4\u56de ${displayStepValue(expected)}`;
  if (assertion.emptyStateAccepted) return "\u65ad\u8a00\uff1a\u5217\u8868\u4e3a\u7a7a\u6216\u7b26\u5408\u9884\u671f";
  return `\u65ad\u8a00\uff1a${cleanStepTarget(fallbackTarget)}`;
}

function cleanStepTarget(value) {
  return String(value ?? "-")
    .replace(/^\u6253\u5f00\s*/, "")
    .replace(/[:?]\s*$/, "")
    .trim();
}

function displayStepValue(value) {
  if (Array.isArray(value)) return value.join(" / ");
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function actionReadableLabel(action) {
  const labels = {
    navigate: "\u6253\u5f00\u9875\u9762",
    click: "\u70b9\u51fb",
    input: "\u8f93\u5165",
    select: "\u9009\u62e9",
    assert: "\u65ad\u8a00",
    wait: "\u7b49\u5f85",
    provider: "\u83b7\u53d6\u9a8c\u8bc1\u7801",
    confirmWrite: "\u786e\u8ba4\u63d0\u4ea4"
  };
  return labels[action] ?? action ?? "\u6267\u884c";
}

function readableStepTarget(target, step) {
  const value = step.value ?? step.input ?? step.assertion?.expected;
  if (value !== undefined && value !== null && step.action !== "assert") {
    return `${target} = ${typeof value === "string" ? value : JSON.stringify(value)}`;
  }
  return String(target ?? "-");
}

function evidenceSummaryFromPlan(plan) {
  const executionPlan = plan?.pageModelExecutionPlan ?? {};
  const selected = Array.isArray(executionPlan.selectedEvidence) ? executionPlan.selectedEvidence : [];
  const fallback = Array.isArray(executionPlan.fallbackEvidence) ? executionPlan.fallbackEvidence : [];
  const excludedCount = Number(executionPlan.excludedEvidenceCount ?? executionPlan.excludedEvidence?.length ?? 0);
  return { selected, fallback, excludedCount };
}

function renderPageModelEvidenceReadable(plan, legacyKnowledgeHits = []) {
  const evidence = evidenceSummaryFromPlan(plan);
  const usedEvidenceIds = new Set(automationStepsFrom(plan).flatMap((step) => [
    step.evidenceId,
    step.elementId,
    step.assertionId,
    step.actionResultId,
    step.pageModelId
  ]).filter(Boolean));
  const rows = [
    ...evidence.selected.map((item) => ({ ...item, bucket: "selected" })),
    ...evidence.fallback.map((item) => ({ ...item, bucket: "fallback" }))
  ].sort((left, right) => {
    const leftUsed = usedEvidenceIds.has(left.id) || usedEvidenceIds.has(left.pageId);
    const rightUsed = usedEvidenceIds.has(right.id) || usedEvidenceIds.has(right.pageId);
    return Number(rightUsed) - Number(leftUsed);
  }).slice(0, 18);
  if (!rows.length && Array.isArray(legacyKnowledgeHits) && legacyKnowledgeHits.length) {
    return `<p>\u5f53\u524d\u4f7f\u7528\u65e7\u77e5\u8bc6\u68c0\u7d22\u7ed3\u679c\uff1a</p><div class="conversation-table"><table><thead><tr><th>\u6807\u9898</th><th>\u6765\u6e90</th><th>\u7f6e\u4fe1\u5ea6</th></tr></thead><tbody>${legacyKnowledgeHits
      .map((item) => `<tr><td>${escapeHtml(item.title ?? "-")}</td><td>${escapeHtml(item.sourceType ?? "-")}</td><td>${Math.round((item.confidence ?? 0) * 100)}%</td></tr>`)
      .join("")}</tbody></table></div>`;
  }
  const summary = `<p>\u5f53\u524d Web AI \u52a9\u624b\u4e3b\u94fe\u8def\u4f7f\u7528 Page Model Store\u3002\u65e7 knowledgeHits \u5728\u8be5\u5206\u652f\u901a\u5e38\u4e3a 0\uff0c\u4e0d\u4ee3\u8868\u6ca1\u6709\u8bc1\u636e\uff1b\u771f\u5b9e\u8bc1\u636e\u89c1 selected/fallback\u3002</p>
    <ul><li>selectedEvidence: ${evidence.selected.length}</li><li>fallbackEvidence: ${evidence.fallback.length}</li><li>excludedEvidence: ${evidence.excludedCount}</li></ul>`;
  if (!rows.length) return `${summary}<div class="empty-card">\u672a\u547d\u4e2d Page Model \u8bc1\u636e\uff0c\u9700\u8981\u5148\u5efa\u6a21\u6216\u8865\u91c7\u3002</div>`;
  return `${summary}<div class="conversation-table"><table><thead><tr><th>\u7c7b\u578b</th><th>\u8bc1\u636e</th><th>\u9875\u9762</th><th>\u72b6\u6001</th><th>\u7f6e\u4fe1\u5ea6</th></tr></thead><tbody>${rows
    .map((item) => `<tr>
      <td>${escapeHtml(item.bucket ?? item.kind ?? "-")}</td>
      <td>${escapeHtml(item.semanticName ?? item.id ?? "-")}</td>
      <td>${escapeHtml(item.pageId ?? "-")}</td>
      <td>${escapeHtml(item.status ?? "-")}</td>
      <td>${item.confidence !== undefined ? `${Math.round(Number(item.confidence) * 100)}%` : "-"}</td>
    </tr>`)
    .join("")}</tbody></table></div>`;
}

function renderPlanAssertions(items, plan) {
  if (!items.length) return `<div class="empty-card">未检测到用户断言；平台将只执行操作步骤，不额外判断业务结果。</div>`;
  const assertionSteps = assertionStepsFrom(plan);
  return items
    .map((item, index) => {
      const intent = item.assertionIntent ?? {};
      const hasDslStep = assertionSteps.some((step) => {
        const assertion = step.assertion ?? {};
        return assertion.target === item.rawText || assertion.intent?.expected === intent.expected;
      });
      const expected = intent.expected ?? (Array.isArray(item.expectedTexts) ? item.expectedTexts.join(", ") : "");
      return `<article class="assertion-card ${hasDslStep ? "assertion-ready" : "assertion-gap"}">
        <header>
          <strong>#${index + 1} ${escapeHtml(assertionKindLabel(item.kind))}</strong>
          <span>${hasDslStep ? "已生成 DSL 断言" : "未生成 DSL 断言"}</span>
        </header>
        <p>${escapeHtml(item.rawText ?? "")}</p>
        <dl>
          <div><dt>目标页面</dt><dd>${escapeHtml(intent.targetPage ?? "-")}</dd></div>
          <div><dt>目标对象</dt><dd>${escapeHtml(intent.targetObject ?? "-")}</dd></div>
          <div><dt>字段</dt><dd>${escapeHtml(intent.field ?? "-")}</dd></div>
          <div><dt>判断</dt><dd>${escapeHtml(intent.operator ?? item.kind ?? "-")}</dd></div>
          <div><dt>期望值</dt><dd>${escapeHtml(expected || "-")}</dd></div>
          <div><dt>允许空状态</dt><dd>${Boolean(item.acceptsEmptyState || intent.emptyStateAccepted) ? "是" : "否"}</dd></div>
          <div><dt>解析来源</dt><dd>${escapeHtml(assertionSourceLabel(intent.source))}</dd></div>
          <div><dt>置信度</dt><dd>${item.confidence !== undefined ? `${Math.round(Number(item.confidence) * 100)}%` : "-"}</dd></div>
        </dl>
        <div class="evidence-line">映射证据：${escapeHtml((item.mappedEvidence ?? []).map((evidence) => evidence.id).join(", ") || "无")}</div>
      </article>`;
    })
    .join("");
}

function renderAssertionSummariesV2(items, plan) {
  const plannedAssertions = planAssertionsFrom(plan);
  if (!items.length) {
    if (!plannedAssertions.length) return `<div class="empty-card">本次需求没有用户断言；平台只执行操作。</div>`;
    return `<div class="empty-card">已生成 ${plannedAssertions.length} 个用户断言，等待执行返回结果。</div>`;
  }
  return items
    .map((item, index) => {
      const status = String(item.status ?? "unknown").toLowerCase();
      return `<article class="assertion-card ${status === "passed" || status === "pass" ? "assertion-pass" : "assertion-fail"}">
        <header>
          <strong>#${index + 1} ${escapeHtml(item.type ?? "assertion")}</strong>
          <span>${escapeHtml(status)}</span>
        </header>
        <dl>
          <div><dt>表/列表</dt><dd>${escapeHtml(item.table ?? "-")}</dd></div>
          <div><dt>字段</dt><dd>${escapeHtml(item.column ?? "-")}</dd></div>
          <div><dt>期望</dt><dd>${escapeHtml(item.expected !== undefined ? JSON.stringify(item.expected) : "-")}</dd></div>
          <div><dt>允许空状态</dt><dd>${item.emptyStateAccepted === undefined ? "-" : Boolean(item.emptyStateAccepted) ? "是" : "否"}</dd></div>
        </dl>
        ${item.actual !== undefined ? `<div class="evidence-line">实际观察：${escapeHtml(JSON.stringify(item.actual))}</div>` : ""}
        ${item.error ? `<div class="error-line">失败原因：${escapeHtml(item.error)}</div>` : ""}
      </article>`;
    })
    .join("");
}

function renderPlanAssertionsReadable(items, plan) {
  if (!items.length) return `<div class="empty-card">\u672a\u68c0\u6d4b\u5230\u7528\u6237\u65ad\u8a00\uff1b\u5e73\u53f0\u53ea\u6267\u884c\u64cd\u4f5c\u6b65\u9aa4\u3002</div>`;
  const assertionSteps = assertionStepsFrom(plan);
  return items
    .map((item, index) => {
      const intent = item.assertionIntent ?? {};
      const step = assertionSteps.find((candidate) => {
        const assertion = candidate.assertion ?? {};
        return assertion.target === item.rawText || assertion.intent?.expected === intent.expected;
      });
      const assertion = step?.assertion ?? {};
      const expected = intent.expected ?? (Array.isArray(item.expectedTexts) ? item.expectedTexts.join(", ") : "");
      return `<article class="assertion-card ${step ? "assertion-ready" : "assertion-gap"}">
        <header><strong>#${index + 1} ${escapeHtml(assertionKindLabel(item.kind))}</strong><span>${step ? "\u5df2\u751f\u6210 DSL \u65ad\u8a00 \u2713" : "\u672a\u751f\u6210 DSL \u65ad\u8a00"}</span></header>
        <p>${escapeHtml(item.rawText ?? "")}</p>
        <dl>
          <div><dt>\u9875\u9762</dt><dd>${escapeHtml(intent.targetPage ?? "-")}</dd></div>
          <div><dt>\u5bf9\u8c61</dt><dd>${escapeHtml(intent.targetObject ?? "-")}</dd></div>
          <div><dt>\u7528\u6237\u5b57\u6bb5</dt><dd>${escapeHtml(intent.field ?? "-")}</dd></div>
          <div><dt>\u5b9e\u9645\u65ad\u8a00\u5217</dt><dd>${escapeHtml(assertion.column ?? "-")}</dd></div>
          <div><dt>\u5224\u65ad</dt><dd>${escapeHtml(intent.operator ?? item.kind ?? "-")}</dd></div>
          <div><dt>\u671f\u671b</dt><dd>${escapeHtml(expected || "-")}</dd></div>
          <div><dt>\u5141\u8bb8\u7a7a\u7ed3\u679c</dt><dd>${Boolean(item.acceptsEmptyState || intent.emptyStateAccepted) ? "\u662f" : "\u5426"}</dd></div>
          <div><dt>\u7406\u89e3\u6765\u6e90</dt><dd>${escapeHtml(assertionSourceLabel(intent.source))}</dd></div>
        </dl>
        ${assertion.columnMapping ? `<div class="evidence-line">\u5b57\u6bb5\u6620\u5c04\uff1a${escapeHtml(assertion.columnMapping.filterField ?? intent.field ?? "-")} \u2192 ${escapeHtml(assertion.columnMapping.resultColumn ?? assertion.column ?? "-")}</div>` : ""}
        <div class="evidence-line">\u8bc1\u636e\uff1a${escapeHtml((item.mappedEvidence ?? []).map((evidence) => evidence.id).join(", ") || "\u65e0")}</div>
      </article>`;
    })
    .join("");
}

function renderAssertionSummariesReadable(items, plan) {
  const plannedAssertions = planAssertionsFrom(plan);
  if (!items.length) {
    if (!plannedAssertions.length) return `<div class="empty-card">\u672c\u6b21\u9700\u6c42\u6ca1\u6709\u7528\u6237\u65ad\u8a00\uff1b\u5e73\u53f0\u53ea\u6267\u884c\u64cd\u4f5c\u3002</div>`;
    return `<div class="empty-card">\u5df2\u751f\u6210 ${plannedAssertions.length} \u4e2a\u7528\u6237\u65ad\u8a00\uff0c\u7b49\u5f85\u6267\u884c\u8fd4\u56de\u7ed3\u679c\u3002</div>`;
  }
  return items
    .map((item, index) => {
      const status = String(item.status ?? "unknown").toLowerCase();
      const diagnostics = item.diagnostics ?? item.actual?.diagnostics ?? {};
      const observedValues = Array.isArray(item.actual?.typeValues) ? item.actual.typeValues : [];
      const observedHeaders = Array.isArray(diagnostics.observedHeaders) ? diagnostics.observedHeaders : [];
      const selectedFilters = Array.isArray(diagnostics.selectedFilters) ? diagnostics.selectedFilters : [];
      const rowSample = Array.isArray(diagnostics.rowSample) ? diagnostics.rowSample : [];
      const messageDetails = renderMessageAssertionDetails(item, diagnostics);
      const title = readableAssertionSummaryTitle(item, index);
      const passed = status === "passed" || status === "pass";
      const detailHtml = [
        observedHeaders.length ? `<div class="evidence-line">\u89c2\u5bdf\u5230\u7684\u8868\u5934\uff1a${escapeHtml(observedHeaders.join(" / "))}</div>` : "",
        selectedFilters.length ? `<div class="evidence-line">\u5f53\u524d\u7b5b\u9009\uff1a${escapeHtml(selectedFilters.map((filter) => `${filter.label}=${filter.value}`).join(" / "))}</div>` : "",
        observedValues.length ? `<div class="evidence-line">\u5b9e\u9645\u5217\u503c\uff1a${escapeHtml(observedValues.join(" / "))}</div>` : "",
        messageDetails,
        rowSample.length ? `<details class="assertion-debug"><summary>\u884c\u6837\u4f8b</summary><pre>${escapeHtml(rowSample.slice(0, 80).join("\n"))}</pre></details>` : "",
        item.error ? `<div class="error-line">\u5931\u8d25\u539f\u56e0\uff1a${escapeHtml(item.error)}</div>` : ""
      ].filter(Boolean).join("");
      return `<article class="assertion-card ${status === "passed" || status === "pass" ? "assertion-pass" : "assertion-fail"}">
        <header><strong>${escapeHtml(title)}</strong><span>${passed ? "\u901a\u8fc7 \u2713" : "\u5931\u8d25"}</span></header>
        <dl>
          <div><dt>\u65ad\u8a00\u5217</dt><dd>${escapeHtml(item.column ?? diagnostics.requestedColumn ?? "-")}</dd></div>
          <div><dt>\u671f\u671b</dt><dd>${escapeHtml(item.expected !== undefined ? JSON.stringify(item.expected) : "-")}</dd></div>
          <div><dt>\u6839\u56e0</dt><dd>${escapeHtml(diagnostics.rootCause ?? "-")}</dd></div>
        </dl>
        ${detailHtml ? `<details class="assertion-debug"${passed ? "" : " open"}><summary>\u65ad\u8a00\u8bca\u65ad\u660e\u7ec6</summary>${detailHtml}</details>` : ""}
      </article>`;
    })
    .join("");
}

function renderMessageAssertionDetails(item, diagnostics) {
  if (item.type !== "message_visible_exact" && diagnostics.assertionType !== "message_visible_exact") return "";
  const actual = item.actual ?? {};
  const matchedText = actual.matchedText ?? diagnostics.matched?.text;
  const bestCandidates = Array.isArray(diagnostics.bestCandidates)
    ? diagnostics.bestCandidates
    : Array.isArray(actual.bestCandidates)
      ? actual.bestCandidates
      : [];
  const observedMessages = Array.isArray(actual.observedMessages) ? actual.observedMessages : [];
  return [
    `<div class="evidence-line">\u63d0\u793a\u65ad\u8a00\uff1a${escapeHtml(diagnostics.matchMode ?? "normalized_exact")}\uff0c\u89c2\u5bdf ${escapeHtml(String(diagnostics.observeWindowMs ?? 3000))}ms</div>`,
    matchedText ? `<div class="evidence-line">\u547d\u4e2d\u63d0\u793a\uff1a${escapeHtml(String(matchedText))}</div>` : "",
    bestCandidates.length ? `<div class="error-line">\u9ad8\u76f8\u4f3c\u9875\u9762\u5185\u5bb9\uff1a${bestCandidates.map((candidate) => `\u300c${escapeHtml(candidate.text ?? "")}\u300d ${Math.round(Number(candidate.similarity ?? 0) * 100)}% / ${escapeHtml(candidate.source ?? "-")} / ${escapeHtml(String(candidate.firstSeenMs ?? "-"))}-${escapeHtml(String(candidate.lastSeenMs ?? "-"))}ms`).join("\uff1b")}</div>` : "",
    observedMessages.length ? `<details class="assertion-debug"><summary>\u89c2\u5bdf\u5230\u7684\u63d0\u793a\u5019\u9009</summary><pre>${escapeHtml(JSON.stringify(observedMessages, null, 2))}</pre></details>` : ""
  ].join("");
}

function readableAssertionSummaryTitle(item, index) {
  if (item.readableText) return String(item.readableText);
  if (item.type === "message_visible_exact") return `\u6b65\u9aa4 ${String(index + 1).padStart(2, "0")} \u65ad\u8a00\uff1a\u9875\u9762\u63d0\u793a\u7b49\u4e8e ${displayStepValue(item.expected ?? item.diagnostics?.expected ?? "")}`;
  const stepIndex = Number.isFinite(Number(item.stepIndex)) ? Number(item.stepIndex) : index + 1;
  const column = item.column ?? item.diagnostics?.requestedColumn ?? item.actual?.diagnostics?.requestedColumn;
  const expected = item.expected ?? item.diagnostics?.expected ?? item.actual?.diagnostics?.expected;
  const prefix = `\u6b65\u9aa4 ${String(stepIndex).padStart(2, "0")} \u65ad\u8a00`;
  if (column && expected !== undefined) return `${prefix}\uff1a${column}\u5217\u4ec5\u8fd4\u56de ${displayStepValue(expected)}`;
  if (item.emptyStateAccepted) return `${prefix}\uff1a\u5217\u8868\u4e3a\u7a7a\u6216\u7b26\u5408\u9884\u671f`;
  return `${prefix}\uff1a${item.type ?? "assertion"}`;
}

function assertionStepsFrom(plan) {
  return automationStepsFrom(plan).filter((step) => step?.action === "assert");
}

function automationStepsFrom(plan) {
  const executionPlan = plan?.pageModelExecutionPlan ?? {};
  const candidates = [
    plan?.steps?.steps,
    plan?.steps,
    executionPlan.automationCase,
    executionPlan.materialization?.case?.steps
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function renderDeepSeekPlanningDetails(plan) {
  if (!plan) return `<div class="empty-card">暂无 AI 规划明细。</div>`;
  const executionPlan = plan.pageModelExecutionPlan ?? {};
  const context = executionPlan.planningContext ?? {};
  const manual = context.retrievedOperationManualContext ?? {};
  const intentStage = plan.aiIntent ?? plan.pageModelDeepSeekIntent ?? {};
  const dslStage = plan.aiDslAdvisor ?? plan.pageModelDeepSeek ?? {};
  const automationCase = executionPlan.automationCase ?? {};
  const steps = Array.isArray(automationCase.steps) ? automationCase.steps : [];
  return [
    deepSeekBlock("第一轮：AI 理解用户意图", {
      status: intentStage.status,
      model: intentStage.model,
      parsedOutput: intentStage.parsedOutput,
      rawOutput: intentStage.rawOutput,
      prompt: intentStage.prompt,
      error: intentStage.error
    }),
    deepSeekBlock("本地知识匹配：操作手册", {
      manuals: manual.manuals,
      capabilities: manual.capabilities,
      providerFlows: manual.providerFlows,
      successEvidencePolicies: manual.successEvidencePolicies,
      modelingRules: manual.modelingRules,
      gaps: manual.gaps
    }),
    deepSeekBlock("本地知识匹配：Page Model", context.retrievedPageModelContext ?? {}),
    deepSeekBlock("第二轮：AI 压缩审查上下文", {
      mode: dslStage.mode,
      telemetry: dslStage.telemetry,
      prompt: dslStage.prompt
    }),
    deepSeekBlock("第二轮：AI 压缩审查返回", {
      status: dslStage.status,
      mode: dslStage.mode,
      model: dslStage.model,
      parsedOutput: dslStage.parsedOutput,
      rawOutput: dslStage.rawOutput,
      error: dslStage.error
    }),
    renderDslContractSummary(executionPlan.dslValidation),
    renderStepExplainTrace(steps),
    deepSeekBlock("本地最终 DSL / Validator 结果", {
      executable: plan.executable,
      readiness: plan.readiness,
      gaps: plan.gaps,
      blockingGaps: plan.blockingGaps,
      dslValidation: executionPlan.dslValidation,
      automationCase: executionPlan.automationCase
    })
  ].join("");
}

function renderDslContractSummary(validation) {
  if (!validation) return deepSeekBlock("DSL Contract 校验", { status: "missing" });
  const failed = Array.isArray(validation.stepResults) ? validation.stepResults.filter((item) => !item.passed) : [];
  const chips = [
    `<span class="${validation.passed ? "pass" : "fail"}">${validation.passed ? "通过" : "未通过"}</span>`,
    `<span>规则 ${Array.isArray(validation.checkedRules) ? validation.checkedRules.length : 0}</span>`,
    `<span>步骤 ${Array.isArray(validation.stepResults) ? validation.stepResults.length : 0}</span>`,
    `<span>问题 ${Array.isArray(validation.contractGaps) ? validation.contractGaps.length : 0}</span>`
  ].join("");
  return [
    `<details class="assertion-debug dsl-contract-panel" open>`,
    `<summary>DSL Contract 校验 <small>${chips}</small></summary>`,
    failed.length ? `<div class="evidence-line">未通过步骤：${failed.map((item) => escapeHtml(`${item.stepId}:${(item.gaps ?? []).join(",")}`)).join("；")}</div>` : `<div class="evidence-line">所有 DSL 步骤均满足当前合同约束。</div>`,
    `<pre>${escapeHtml(JSON.stringify(validation, null, 2))}</pre>`,
    `</details>`
  ].join("");
}

function renderStepExplainTrace(steps) {
  if (!Array.isArray(steps) || !steps.length) return deepSeekBlock("本地最终 DSL Step Explain", { steps: [] });
  const cards = steps.map((step, index) => {
    const explain = step.explain ?? {};
    const target = step.semanticTarget ?? step.semantic_target ?? step.target ?? step.id;
    return [
      `<div class="step-explain-card">`,
      `<div class="step-explain-head"><span>${String(index + 1).padStart(2, "0")}</span><strong>${escapeHtml(step.action ?? "-")}</strong><p>${escapeHtml(target)}</p></div>`,
      `<dl>`,
      `<div><dt>页面</dt><dd>${escapeHtml(step.pageModelId ?? explain.pageModelId ?? "-")}</dd></div>`,
      `<div><dt>元素/断言</dt><dd>${escapeHtml(step.elementId ?? step.targetElementId ?? step.assertionId ?? explain.elementId ?? explain.assertionId ?? "-")}</dd></div>`,
      `<div><dt>证据</dt><dd>${escapeHtml(step.evidenceId ?? explain.evidenceId ?? "-")}</dd></div>`,
      `<div><dt>置信度</dt><dd>${escapeHtml(explain.confidence ?? "-")}</dd></div>`,
      `</dl>`,
      `<details class="step-tech"><summary>查看 explain JSON</summary><pre>${escapeHtml(JSON.stringify(explain, null, 2))}</pre></details>`,
      `</div>`
    ].join("");
  }).join("");
  return `<details class="assertion-debug step-explain-panel" open><summary>本地最终 DSL Step Explain</summary><div class="step-explain-list">${cards}</div></details>`;
}

function renderExecutionArtifacts(result) {
  const rows = [
    ["Run ID", result.runId],
    ["失败包", result.failurePackagePath],
    ["失败提示词", result.failurePromptPath],
    ["待审核知识更新", result.proposalPath],
    ["Case Run", result.caseRunPath]
  ].filter(([, value]) => value);
  if (!rows.length) return "";
  return conversationDetails("诊断产物", `<div class="artifact-link-list">${rows.map(([label, value]) => `<div><strong>${escapeHtml(label)}</strong><code>${escapeHtml(value)}</code></div>`).join("")}</div>`, true);
}

function deepSeekBlock(title, value) {
  return `<details class="assertion-debug"><summary>${escapeHtml(title)}</summary><pre>${escapeHtml(JSON.stringify(value ?? {}, null, 2))}</pre></details>`;
}

function renderGapList(items, kind) {
  if (!Array.isArray(items) || !items.length) return "";
  return `<div class="${kind === "blocking" ? "blocking-gap-list" : "gap-list"}">${items.map((item) => {
    const localized = localizeGap(item);
    const raw = String(item);
    const label = localized === raw ? raw : `${localized}（技术码：${raw}）`;
    return `<span title="${escapeHtml(raw)}">${escapeHtml(label)}</span>`;
  }).join("")}</div>`;
}

function localizeGap(item) {
  const raw = String(item ?? "");
  if (raw === "provider_verification_step_not_materialized") return "需要完成验证码/安全验证，但当前 DSL 没有生成发送验证码、输入 GA/TOTP、输入邮箱/短信验证码或确认验证步骤。";
  if (raw === "write_success_assertion_not_materialized") return "这是写操作并期望成功，但当前 DSL 没有生成成功断言，例如成功提示、列表新增、接口成功或弹窗关闭。";
  if (raw.startsWith("provider_component_candidate_not_executable:")) return `验证码/安全验证组件仍是候选建模，不能进入执行：${raw.split(":").slice(1).join(":")}`;
  if (raw.startsWith("provider_component_missing_executable_locator:")) return `验证码/安全验证组件缺少真实可执行定位，不能使用占位文本执行：${raw.split(":").slice(1).join(":")}`;
  if (raw === "missing_page_model_store") return "当前项目还没有 Page Model Store，需要先建模。";
  if (raw === "operation_manual_store_missing") return "当前项目还没有 Operation Manual Store，需要先补充页面操作手册。";
  if (raw === "operation_manual_not_found_for_intent") return "没有找到匹配当前意图的页面操作手册。";
  if (raw === "operation_manual_capability_not_found_for_intent") return "页面操作手册中没有找到匹配当前操作的 capability。";
  if (raw === "operation_manual_provider_flow_missing") return "操作手册声明了验证流程，但没有找到对应 Provider Flow 定义。";
  if (raw === "operation_manual_success_policy_missing") return "操作手册声明了成功判断策略，但没有找到对应 Success Evidence Policy。";
  if (raw.startsWith("dropdown_component_missing_option_discovery:")) return `下拉框缺少选项采集方式，无法确认如何选择：${raw.split(":").slice(1).join(":")}`;
  if (raw.startsWith("dropdown_component_option_not_modeled:")) {
    const parts = raw.split(":");
    return `下拉框没有建模目标选项：元素 ${parts[1] ?? "未知"}，期望值 ${parts.slice(2).join(":") || "未知"}`;
  }
  if (raw.startsWith("dropdown_component_target_option_not_verified:")) {
    const parts = raw.split(":");
    return `下拉框目标选项尚未完成可执行验证，需要补采建模：元素 ${parts[1] ?? "未知"}，期望值 ${parts.slice(2).join(":") || "未知"}`;
  }
  if (raw.startsWith("dropdown_component_missing_selected_value_signal:")) return `下拉框缺少选中值回显/持久化信号，无法证明选择已成功：${raw.split(":").slice(1).join(":")}`;
  if (raw.startsWith("plan_page_boundary_violation:")) return `计划包含了目标页面外的步骤，已阻断：${raw.split(":").slice(1).join(":")}`;
  if (raw.startsWith("plan_operation_boundary_violation:")) return `读操作计划中混入了提交/确认等写操作，已阻断：${raw.split(":").slice(1).join(":")}`;
  if (raw.startsWith("intent_arbitration_conflict:")) return `生成内容可信度校验发现历史兼容冲突 gap：${raw.split(":").slice(1).join(":")}。本地不应继续扩展意图仲裁规则。`;
  if (raw === "intent_contract_page_missing") return "生成内容可信度校验未找到目标页面证据。";
  if (raw.startsWith("intent_contract_required_data_missing:")) return `生成内容可信度校验发现必填数据缺失：${raw.split(":").slice(1).join(":")}`;
  if (raw.startsWith("intent_contract_provider_flow_missing:")) return `生成内容可信度校验发现 provider flow 未落库：${raw.split(":").slice(1).join(":")}`;
  if (raw.startsWith("intent_contract_assertion_type_unsupported:")) return `生成内容可信度校验发现断言类型暂不受支持：${raw.split(":").slice(1).join(":")}`;
  if (raw.startsWith("intent_contract_success_policy_missing:")) return `生成内容可信度校验警告：成功证据策略未落库：${raw.split(":").slice(1).join(":")}`;
  if (raw === "intent_contract_operation_type_mismatch") return "生成内容可信度校验警告：操作类型与能力声明存在边界差异，但不阻断已物化 DSL。";
  if (raw === "intent_contract_capability_missing") return "生成内容可信度校验警告：操作手册缺少匹配 capability，但 Page Model 已提供可物化证据。";
  if (raw.startsWith("raw_scan_evidence_not_executable:")) return `计划使用了原始扫描候选证据，尚未达到执行级建模标准：${raw.split(":").slice(1).join(":")}`;
  if (/fund_flow_.*_option:/.test(raw)) return `资金流水筛选缺少目标下拉选项建模：${raw}`;
  if (/fund_flow_result_assertion/.test(raw)) return "资金流水页面缺少结果列表/空状态断言能力。";
  return raw;
}

function assertionKindLabel(kind) {
  const labels = {
    result_empty: "列表为空",
    record_or_empty_state: "记录或空状态",
    record_contains: "记录包含",
    table_column_all_equal: "列值全等",
    table_column_all_equal_or_empty: "列值全等或空状态",
    success_message: "成功信号",
    failure_message: "失败信号",
    field_value: "字段值",
    unknown: "未知断言"
  };
  return labels[kind] ?? kind ?? "断言";
}

function assertionSourceLabel(source) {
  if (source === "deepseek") return "DeepSeek";
  if (source === "local_fallback") return "本地兜底";
  return source ?? "-";
}

function assistantTraceStatusText(status) {
  if (status === "running") return "进行中";
  if (status === "needs_confirmation") return "待确认";
  if (status === "failed") return "失败";
  return "完成";
}

async function sendAssistantMessageV3() {
  const message = $("assistantMessage").value.trim();
  if (!message) {
    $("assistantStatus").textContent = "\u8bf7\u5148\u8f93\u5165\u9700\u6c42\u3002";
    return;
  }
  assistantActionSignature = assistantCurrentSignature();
  assistantAbortController = new AbortController();
  const requestToken = ++assistantRequestToken;
  updateAssistantPrimaryAction("planning");
  assistantPlanningStageEvents = [];
  saveAssistantRequestHistory(message);
  resetAssistantConversation();
  appendAssistantConversationMessage("user", "\u9700\u6c42", `<p>${escapeHtml(message)}</p>`);
  appendAssistantConversationMessage(
    "ai",
    "\u6b63\u5728\u5904\u7406",
    `<ul><li>\u89e3\u6790\u81ea\u7136\u8bed\u8a00\u9700\u6c42</li><li>\u9009\u62e9 Page Model \u8bc1\u636e</li><li>\u751f\u6210 DSL \u8349\u6848</li><li>\u8bc6\u522b\u7528\u6237\u65ad\u8a00</li></ul>`,
    { id: "assistantPlanningMessage", badge: "running", status: "running" }
  );
  $("assistantPlan").textContent = "\u6b63\u5728\u751f\u6210...";
  $("assistantPlanOverview").innerHTML = "\u6b63\u5728\u7406\u89e3\u9700\u6c42...";
  $("assistantAssertionUnderstanding").innerHTML = "\u6b63\u5728\u89e3\u6790\u65ad\u8a00...";
  $("assistantAssertionResults").innerHTML = "\u7b49\u5f85\u6267\u884c\u3002";
  $("assistantKnowledgeRows").innerHTML = "";
  const stopProgress = startAssistantProgress();
  try {
    const result = await fetchAssistantPlanStream({
      project: selectedWorkbenchProject(),
      env: selectedWorkbenchEnv(),
      message,
      signal: assistantAbortController.signal,
      onEvent: (event) => {
        if (requestToken !== assistantRequestToken) return;
        if (event.type === "stage") updateAssistantPlanningStageEvent(event);
      }
    });
    if (requestToken !== assistantRequestToken) return;
    assistantAbortController = null;
    stopProgress("completed");
    if (result.error) {
      $("assistantStatus").textContent = result.error;
      $("assistantPlan").textContent = result.error;
      appendAssistantConversationMessage("ai", "\u8ba1\u5212\u751f\u6210\u5931\u8d25", `<p>${escapeHtml(result.error)}</p>`, { badge: "failed", status: "failed" });
      updateAssistantPrimaryAction("idle");
      return;
    }
    currentAssistantPlan = result.plan ?? null;
    $("assistantStatus").textContent = `\u5df2\u751f\u6210\u8ba1\u5212\uff1a${result.usedModel}`;
    if ($("assistantPlanMiniState")) $("assistantPlanMiniState").textContent = "\u5df2\u751f\u6210";
    renderAssistantTrace(result.trace ?? []);
    const planningTraceHtml = renderAssistantPlanningStageEventsHtml("completed");
    $("assistantPlanOverview").innerHTML = renderAssistantPlanOverview(result.plan);
    $("assistantAssertionUnderstanding").innerHTML = renderPlanAssertionsReadable(planAssertionsFrom(result.plan), result.plan);
    $("assistantAssertionResults").innerHTML = renderAssertionSummariesReadable([], result.plan);
    $("assistantPlan").textContent = JSON.stringify(result.plan ?? {}, null, 2);
    renderAssistantKnowledge(result.knowledgeHits ?? []);
    const evidenceHtml = renderPageModelEvidenceReadable(result.plan, result.knowledgeHits ?? []);
    const deepSeekHtml = renderDeepSeekPlanningDetails(result.plan);
    const hasPlanningIssue = !result.plan?.executable || (Array.isArray(result.plan?.gaps) && result.plan.gaps.length > 0) || (Array.isArray(result.plan?.blockingGaps) && result.plan.blockingGaps.length > 0);
    const planHtml = [
      planningTraceHtml,
      conversationDetails("计划摘要", $("assistantPlanOverview").innerHTML, hasPlanningIssue),
      conversationDetails("\u65ad\u8a00\u7406\u89e3", $("assistantAssertionUnderstanding").innerHTML, hasPlanningIssue),
      conversationDetails("DeepSeek / DSL \u751f\u6210\u8fc7\u7a0b", deepSeekHtml, hasPlanningIssue),
      conversationDetails("Page Model \u8bc1\u636e", evidenceHtml, hasPlanningIssue),
      conversationDetails("DSL \u6280\u672f\u660e\u7ec6", `<pre>${escapeHtml($("assistantPlan").textContent)}</pre>`),
      conversationDetails("后端真实 trace", renderAssistantPlanningTraceDetails(result.trace ?? []), hasPlanningIssue)
    ].join("");
    updateAssistantConversationMessage("assistantPlanningMessage", "\u5df2\u751f\u6210\u6267\u884c\u8ba1\u5212", planHtml, { badge: "ready", status: "completed" });
    renderAssistantStepProgress(currentAssistantPlan, { mode: "planned" });
    updateAssistantPrimaryAction("ready");
  } catch (error) {
    if (requestToken !== assistantRequestToken) return;
    stopProgress(error?.name === "AbortError" ? "stopped" : "failed");
    assistantAbortController = null;
    const message = error instanceof Error ? error.message : String(error);
    if (error?.name === "AbortError") {
      $("assistantStatus").textContent = "已停止生成计划。";
      updateAssistantConversationMessage("assistantPlanningMessage", "计划生成已停止", `<p>用户已停止当前计划生成。</p>`, { badge: "stopped", status: "failed" });
      updateAssistantPrimaryAction("idle");
      return;
    }
    $("assistantStatus").textContent = message;
    $("assistantPlan").textContent = message;
    updateAssistantConversationMessage("assistantPlanningMessage", "\u8ba1\u5212\u751f\u6210\u5f02\u5e38", `<p>${escapeHtml(message)}</p>`, { badge: "failed", status: "failed" });
    updateAssistantPrimaryAction("idle");
  }
}

async function sendAssistantMessageV3Legacy() {
  const message = $("assistantMessage").value.trim();
  if (!message) {
    $("assistantStatus").textContent = "\u8bf7\u5148\u8f93\u5165\u9700\u6c42\u3002";
    return;
  }
  assistantActionSignature = assistantCurrentSignature();
  assistantAbortController = new AbortController();
  const requestToken = ++assistantRequestToken;
  updateAssistantPrimaryAction("planning");
  saveAssistantRequestHistory(message);
  resetAssistantConversation();
  appendAssistantConversationMessage("user", "\u9700\u6c42", `<p>${escapeHtml(message)}</p>`);
  appendAssistantConversationMessage(
    "ai",
    "\u6b63\u5728\u5904\u7406",
    `<ul><li>\u89e3\u6790\u81ea\u7136\u8bed\u8a00\u9700\u6c42</li><li>\u9009\u62e9 Page Model \u8bc1\u636e</li><li>\u751f\u6210 DSL \u8349\u6848</li><li>\u8bc6\u522b\u7528\u6237\u65ad\u8a00</li></ul>`,
    { id: "assistantPlanningMessage", badge: "running", status: "running" }
  );
  $("assistantPlan").textContent = "\u6b63\u5728\u751f\u6210...";
  $("assistantPlanOverview").innerHTML = "\u6b63\u5728\u7406\u89e3\u9700\u6c42...";
  $("assistantAssertionUnderstanding").innerHTML = "\u6b63\u5728\u89e3\u6790\u65ad\u8a00...";
  $("assistantAssertionResults").innerHTML = "\u7b49\u5f85\u6267\u884c\u3002";
  $("assistantKnowledgeRows").innerHTML = "";
  const stopProgress = startAssistantProgress();
  try {
    const response = await fetch("/api/assistant/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: selectedWorkbenchProject(), env: selectedWorkbenchEnv(), message }),
      signal: assistantAbortController.signal
    });
    const result = await response.json();
    if (requestToken !== assistantRequestToken) return;
    assistantAbortController = null;
    stopProgress("completed");
    if (result.error) {
      $("assistantStatus").textContent = result.error;
      $("assistantPlan").textContent = result.error;
      renderAssistantPlanningProgress(assistantPlanningProgressSteps(), 4, "failed");
      appendAssistantConversationMessage("ai", "\u8ba1\u5212\u751f\u6210\u5931\u8d25", `<p>${escapeHtml(result.error)}</p>`, { badge: "failed", status: "failed" });
      updateAssistantPrimaryAction("idle");
      return;
    }
    currentAssistantPlan = result.plan ?? null;
    $("assistantStatus").textContent = `\u5df2\u751f\u6210\u8ba1\u5212\uff1a${result.usedModel}`;
    if ($("assistantPlanMiniState")) $("assistantPlanMiniState").textContent = "\u5df2\u751f\u6210";
    renderAssistantTrace(result.trace ?? []);
    const planningTraceHtml = renderAssistantPlanningStageEventsHtml("completed");
    $("assistantPlanOverview").innerHTML = renderAssistantPlanOverview(result.plan);
    $("assistantAssertionUnderstanding").innerHTML = renderPlanAssertionsReadable(planAssertionsFrom(result.plan), result.plan);
    $("assistantAssertionResults").innerHTML = renderAssertionSummariesReadable([], result.plan);
    $("assistantPlan").textContent = JSON.stringify(result.plan ?? {}, null, 2);
    renderAssistantKnowledge(result.knowledgeHits ?? []);
    const evidenceHtml = renderPageModelEvidenceReadable(result.plan, result.knowledgeHits ?? []);
    const deepSeekHtml = renderDeepSeekPlanningDetails(result.plan);
    const planHtml = [
      conversationDetails("计划生成进度", planningTraceHtml, true),
      $("assistantPlanOverview").innerHTML,
      conversationDetails("后端真实 trace", renderAssistantPlanningTraceDetails(result.trace ?? [])),
      conversationDetails("\u65ad\u8a00\u7406\u89e3", $("assistantAssertionUnderstanding").innerHTML),
      conversationDetails("DeepSeek / DSL \u751f\u6210\u8fc7\u7a0b", deepSeekHtml),
      conversationDetails("DSL \u6280\u672f\u660e\u7ec6", `<pre>${escapeHtml($("assistantPlan").textContent)}</pre>`),
      conversationDetails("Page Model \u8bc1\u636e", evidenceHtml)
    ].join("");
    updateAssistantConversationMessage("assistantPlanningMessage", "\u5df2\u751f\u6210\u6267\u884c\u8ba1\u5212", planHtml, { badge: "ready", status: "completed" });
    renderAssistantStepProgress(currentAssistantPlan, { mode: "planned" });
    updateAssistantPrimaryAction("ready");
  } catch (error) {
    if (requestToken !== assistantRequestToken) return;
    stopProgress(error?.name === "AbortError" ? "stopped" : "failed");
    assistantAbortController = null;
    const message = error instanceof Error ? error.message : String(error);
    if (error?.name === "AbortError") {
      $("assistantStatus").textContent = "已停止生成计划。";
      updateAssistantConversationMessage("assistantPlanningMessage", "计划生成已停止", `<p>用户已停止当前计划生成。</p>`, { badge: "stopped", status: "failed" });
      updateAssistantPrimaryAction("idle");
      return;
    }
    $("assistantStatus").textContent = message;
    $("assistantPlan").textContent = message;
    updateAssistantConversationMessage("assistantPlanningMessage", "\u8ba1\u5212\u751f\u6210\u5f02\u5e38", `<p>${escapeHtml(message)}</p>`, { badge: "failed", status: "failed" });
    updateAssistantPrimaryAction("idle");
  }
}

async function executeAssistantPlanV3(confirmWrite = false) {
  if (!currentAssistantPlan) {
    $("assistantStatus").textContent = "\u8bf7\u5148\u751f\u6210\u6267\u884c\u8ba1\u5212\u3002";
    updateAssistantPrimaryAction("idle");
    return;
  }
  if (currentAssistantPlan.requiresConfirmation && !confirmWrite) {
    $("confirmPlanText").textContent = `\u5f53\u524d\u8ba1\u5212\u9700\u8981\u786e\u8ba4\u540e\u6267\u884c\u3002\u4efb\u52a1\uff1a${currentAssistantPlan.intent ?? ""}`;
    $("confirmPlanModal").classList.remove("hidden");
    return;
  }
  if (assistantExecutionInFlight) return;
  assistantExecutionInFlight = true;
  assistantActionSignature = assistantCurrentSignature();
  assistantAbortController = new AbortController();
  assistantExecutionRequestId = cryptoRandomId();
  const requestToken = ++assistantRequestToken;
  updateAssistantPrimaryAction("executing");
  renderAssistantStepProgress(currentAssistantPlan, { mode: "running", runningIndex: 0, executionSteps: [] });
  $("assistantAssertionResults").innerHTML = renderAssertionSummariesReadable([], currentAssistantPlan);
  const stopStepProgress = startAssistantExecutionStepPolling(currentAssistantPlan, Date.now());
  $("assistantStatus").textContent = "\u6b63\u5728\u6267\u884c\u5f53\u524d\u8ba1\u5212...";
  if ($("assistantRunMiniState")) $("assistantRunMiniState").textContent = "\u6267\u884c\u4e2d";
  if ($("assistantExecute")) $("assistantExecute").disabled = true;
  renderAssistantTrace([{ step: "\u6267\u884c\u8ba1\u5212", detail: "\u8bf7\u6c42\u540e\u7aef\u6267\u884c\u5668\uff0c\u6d4f\u89c8\u5668\u4efb\u52a1\u6267\u884c\u671f\u95f4\u8bf7\u7b49\u5f85\u8fd4\u56de\u7ed3\u679c\u3002", status: "running", at: new Date().toISOString() }]);
  try {
    const response = await fetch("/api/assistant/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project: selectedWorkbenchProject(),
        env: selectedWorkbenchEnv(),
        message: $("assistantMessage").value,
        plan: currentAssistantPlan,
        confirmWrite,
        executionRequestId: assistantExecutionRequestId,
        observationMode: Boolean($("assistantObservationMode")?.checked)
      }),
      signal: assistantAbortController.signal
    });
    const result = await response.json();
    if (requestToken !== assistantRequestToken) return;
    assistantAbortController = null;
    stopStepProgress();
    const completed = result.exitCode === 0;
    const cancelled = /Execution cancelled/i.test(String(result.stderr || result.stdout || result.error || ""));
    $("assistantPlanOverview").innerHTML = renderAssistantPlanOverview(currentAssistantPlan);
    $("assistantAssertionUnderstanding").innerHTML = renderPlanAssertionsReadable(planAssertionsFrom(currentAssistantPlan), currentAssistantPlan);
    $("assistantAssertionResults").innerHTML = renderAssertionSummariesReadable(result.assertionSummaries ?? [], currentAssistantPlan);
    $("assistantStatus").textContent = cancelled ? "计划执行已暂停。" : completed ? "\u8ba1\u5212\u6267\u884c\u5b8c\u6210\u3002" : "\u8ba1\u5212\u6267\u884c\u672a\u5b8c\u6210\u3002";
    if ($("assistantRunMiniState")) $("assistantRunMiniState").textContent = completed ? "\u5df2\u901a\u8fc7" : "\u672a\u901a\u8fc7";
    renderAssistantTrace([{ step: "\u6267\u884c\u8ba1\u5212", detail: completed ? "\u540e\u7aef\u6267\u884c\u5668\u8fd4\u56de\u6210\u529f\u3002" : `\u540e\u7aef\u6267\u884c\u5668\u8fd4\u56de exitCode=${result.exitCode}\u3002`, status: completed ? "completed" : "failed", at: new Date().toISOString() }]);
    $("assistantPlan").textContent = [JSON.stringify(currentAssistantPlan, null, 2), "", "--- \u6267\u884c\u8f93\u51fa ---", formatCommandResult(result)].join("\n");
    renderAssistantStepProgress(currentAssistantPlan, {
      mode: "completed",
      completed,
      executionSteps: result.executionSteps ?? []
    });
    appendAssistantConversationMessage(
      "ai",
      "\u65ad\u8a00\u7ed3\u679c",
      $("assistantAssertionResults").innerHTML,
      { id: "assistantAssertionMessage", badge: completed ? "done" : "check", status: completed ? "completed" : "failed" }
    );
    saveAssistantRunHistoryRecord(result, completed);
    await refresh();
    await loadAssistantRunHistory();
    updateAssistantPrimaryAction(cancelled ? "ready" : completed ? "executed_passed" : "executed_failed");
  } catch (error) {
    if (requestToken !== assistantRequestToken) return;
    stopStepProgress?.();
    const message = error instanceof Error ? error.message : String(error);
    assistantAbortController = null;
    if (error?.name === "AbortError") {
      $("assistantStatus").textContent = "已停止等待执行结果。";
      appendAssistantConversationMessage("ai", "执行等待已停止", `<p>用户已停止等待当前执行结果；后端任务如已开始，可能仍会继续写入执行记录。</p>`, { badge: "stopped", status: "failed" });
      updateAssistantPrimaryAction("ready");
      return;
    }
    $("assistantStatus").textContent = "\u6267\u884c\u8bf7\u6c42\u5931\u8d25\u3002";
    renderAssistantTrace([{ step: "\u6267\u884c\u8ba1\u5212", detail: message, status: "failed", at: new Date().toISOString() }]);
    $("assistantPlan").textContent = `${JSON.stringify(currentAssistantPlan, null, 2)}\n\n--- \u6267\u884c\u5f02\u5e38 ---\n${message}`;
    appendAssistantConversationMessage("ai", "\u6267\u884c\u8bf7\u6c42\u5f02\u5e38", `<p>${escapeHtml(message)}</p>`, { badge: "failed", status: "failed" });
    saveAssistantRunHistoryRecord({ error: message }, false);
    await loadAssistantRunHistory();
    updateAssistantPrimaryAction("executed_failed");
  } finally {
    assistantExecutionInFlight = false;
    assistantExecutionRequestId = "";
    stopStepProgress?.();
    if ($("assistantExecute")) $("assistantExecute").disabled = false;
  }
}

function escapeHtml(value) {
  return normalizeLegacyDslTerminology(String(value ?? ""))
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeLegacyDslTerminology(value) {
  return String(value ?? "")
    .replaceAll("意图契约校验", "生成内容可信度校验")
    .replaceAll("intent_contract_validation", "grounded_contract_validation");
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function formatDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleString();
}

function formatBytes(value) {
  if (!Number.isFinite(Number(value))) return "";
  const size = Number(value);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

loadProjects()
  .then(refresh)
  .then(loadLarkSettings)
  .catch((error) => {
  const output = $("runConsoleOutput") || $("exploreConsoleOutput");
  if (output) output.textContent = error instanceof Error ? error.message : String(error);
  });

const PROPOSAL_TYPE_LABELS = {
  assertion_observable_update: "断言可观察信号更新",
  assertion_contract_or_observable_update: "断言契约更新",
  element_locator_update: "元素定位更新",
  page_state_or_navigation_update: "页面状态/导航更新",
  intent_boundary_update: "意图边界更新",
  intent_hierarchy_update: "意图层级更新",
  execution_diagnostic_review: "执行诊断复核",
  environment_preflight_gap: "环境预检缺口"
};

function proposalTypeLabel(type) {
  return PROPOSAL_TYPE_LABELS[type] ?? (type || "未知类型");
}

function installKnowledgeProposalReviewView() {
  if ($("knowledgeProposals")) return;
  const main = document.querySelector("main");
  if (!main) return;
  main.insertAdjacentHTML(
    "beforeend",
    `
      <section id="knowledgeProposals" class="view knowledge-proposal-view">
        <section class="workspace-panel knowledge-proposal-panel">
          <div class="knowledge-map-head">
            <div>
              <h2>知识审核</h2>
              <p class="muted">审核执行链路产生的知识更新建议；批准或拒绝都会记录审计日志。</p>
            </div>
            <div class="button-row">
              <label>范围<select id="proposalScope">
                <option value="pending" selected>待审核</option>
                <option value="approved">已批准</option>
                <option value="rejected">已拒绝</option>
                <option value="all">全部</option>
              </select></label>
              <label>类型<select id="proposalTypeFilter"><option value="">全部类型</option></select></label>
              <button id="refreshKnowledgeProposals" type="button" class="secondary-button">刷新</button>
            </div>
          </div>
          <div class="knowledge-map-summary" id="knowledgeProposalSummary"></div>
          <div id="knowledgeProposalList" class="knowledge-proposal-list">等待加载。</div>
          <section id="knowledgeProposalDetail" class="knowledge-proposal-detail" hidden></section>
        </section>
      </section>`
  );
  $("refreshKnowledgeProposals")?.addEventListener("click", loadKnowledgeProposalList);
  $("proposalScope")?.addEventListener("change", loadKnowledgeProposalList);
  $("proposalTypeFilter")?.addEventListener("change", loadKnowledgeProposalList);
}

function truncateProposalText(value, max) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function loadKnowledgeProposalList() {
  if (!$("knowledgeProposalList")) return;
  const project = encodeURIComponent($("project")?.value || "demo");
  const scope = $("proposalScope")?.value || "pending";
  const type = $("proposalTypeFilter")?.value || "";
  $("knowledgeProposalList").innerHTML = `<div class="empty-card">正在加载 proposal。</div>`;
  if ($("knowledgeProposalDetail")) $("knowledgeProposalDetail").hidden = true;
  try {
    const query = new URLSearchParams({ project, scope, limit: "100" });
    if (type) query.set("type", type);
    const payload = await apiJson(`/api/knowledge-proposals?${query.toString()}`);
    renderKnowledgeProposalSummary(payload);
    renderKnowledgeProposalTypeFilter(payload);
    renderKnowledgeProposalList(payload);
  } catch (error) {
    if ($("knowledgeProposalSummary")) $("knowledgeProposalSummary").innerHTML = "";
    $("knowledgeProposalList").innerHTML = `<div class="empty-card">proposal 加载失败：${escapeHtml(error?.message ?? String(error))}</div>`;
  }
}

function renderKnowledgeProposalSummary(payload) {
  const distribution = payload?.typeDistribution ?? {};
  const topTypes = Object.entries(distribution)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([type, count]) => `${proposalTypeLabel(type)}×${count}`)
    .join("，");
  $("knowledgeProposalSummary").innerHTML = `
    <span class="info-badge"><small>项目</small>${escapeHtml(payload?.project ?? "-")}</span>
    <span class="info-badge"><small>范围</small>${escapeHtml(payload?.scope ?? "pending")}</span>
    <span class="info-badge"><small>数量</small>${escapeHtml(String(payload?.total ?? 0))}</span>
    ${topTypes ? `<span class="info-badge"><small>主要类型</small>${escapeHtml(topTypes)}</span>` : ""}`;
}

function renderKnowledgeProposalTypeFilter(payload) {
  const select = $("proposalTypeFilter");
  if (!select) return;
  const current = select.value;
  const types = Object.keys(payload?.typeDistribution ?? {}).sort();
  select.innerHTML = `<option value="">全部类型</option>` +
    types.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(proposalTypeLabel(type))}</option>`).join("");
  select.value = types.includes(current) ? current : "";
}

function renderKnowledgeProposalList(payload) {
  const proposals = Array.isArray(payload?.proposals) ? payload.proposals : [];
  if (!proposals.length) {
    $("knowledgeProposalList").innerHTML = `<div class="empty-card">当前范围内没有 proposal。</div>`;
    return;
  }
  const pending = payload?.scope === "pending";
  $("knowledgeProposalList").innerHTML = proposals.map((item) => `
    <article class="knowledge-proposal-card" data-proposal-id="${escapeHtml(item.proposalId)}">
      <div class="knowledge-proposal-card-head">
        <span class="info-badge"><small>类型</small>${escapeHtml(proposalTypeLabel(item.proposalType))}</span>
        <span class="info-badge"><small>状态</small>${escapeHtml(item.status)}</span>
        <span class="info-badge"><small>环境</small>${escapeHtml(item.project)} / ${escapeHtml(item.env)}</span>
        <span class="info-badge"><small>创建</small>${escapeHtml(formatDate(item.createdAt))}</span>
      </div>
      ${item.reason ? `<p class="knowledge-proposal-reason">${escapeHtml(truncateProposalText(item.reason, 220))}</p>` : ""}
      ${item.userRequest ? `<p class="knowledge-proposal-request muted">需求：${escapeHtml(truncateProposalText(item.userRequest, 160))}</p>` : ""}
      <div class="button-row">
        <button type="button" class="secondary-button proposal-detail-button" data-proposal-id="${escapeHtml(item.proposalId)}">查看详情</button>
        ${pending ? `
        <button type="button" class="proposal-approve-button" data-proposal-id="${escapeHtml(item.proposalId)}">批准</button>
        <button type="button" class="secondary-button proposal-reject-button" data-proposal-id="${escapeHtml(item.proposalId)}">拒绝</button>` : ""}
      </div>
    </article>`).join("");
  document.querySelectorAll(".proposal-detail-button").forEach((button) => {
    button.addEventListener("click", () => loadKnowledgeProposalDetail(button.dataset.proposalId));
  });
  document.querySelectorAll(".proposal-approve-button").forEach((button) => {
    button.addEventListener("click", () => reviewKnowledgeProposalAction(button.dataset.proposalId, "approve"));
  });
  document.querySelectorAll(".proposal-reject-button").forEach((button) => {
    button.addEventListener("click", () => reviewKnowledgeProposalAction(button.dataset.proposalId, "reject"));
  });
}

async function loadKnowledgeProposalDetail(proposalId) {
  const panel = $("knowledgeProposalDetail");
  if (!panel || !proposalId) return;
  panel.hidden = false;
  panel.innerHTML = `<div class="empty-card">正在加载 proposal 详情。</div>`;
  try {
    const payload = await apiJson(`/api/knowledge-proposals/detail?proposalId=${encodeURIComponent(proposalId)}`);
    const proposal = payload?.proposal ?? {};
    const reviewLog = payload?.reviewLog;
    panel.innerHTML = `
      <div class="knowledge-map-head">
        <div>
          <h3>${escapeHtml(proposalTypeLabel(proposal.proposalType))}</h3>
          <p class="muted">${escapeHtml(proposal.proposalId ?? "")}</p>
        </div>
        <button type="button" class="secondary-button" id="closeProposalDetail">关闭</button>
      </div>
      ${reviewLog ? `<div class="info-badge"><small>审核</small>${escapeHtml(reviewLog.action)} · ${escapeHtml(reviewLog.reviewedBy)} · ${escapeHtml(formatDate(reviewLog.reviewedAt))}</div>` : ""}
      ${proposal.proposalType === "page_model_ingest" ? `<section id="knowledgeProposalWriteBackDiff" class="knowledge-proposal-writeback"></section>` : ""}
      <pre class="knowledge-proposal-json">${escapeHtml(JSON.stringify(proposal, null, 2))}</pre>`;
    $("closeProposalDetail")?.addEventListener("click", () => {
      panel.hidden = true;
      panel.innerHTML = "";
    });
    if (proposal.proposalType === "page_model_ingest") {
      loadProposalWriteBackDiff(proposal.proposalId);
    }
  } catch (error) {
    panel.innerHTML = `<div class="empty-card">详情加载失败：${escapeHtml(error?.message ?? String(error))}</div>`;
  }
}

async function reviewKnowledgeProposalAction(proposalId, action) {
  if (!proposalId) return;
  const label = action === "approve" ? "批准" : "拒绝";
  const note = window.prompt(`确认${label}该 proposal？可填写审核备注（可选）：`, "");
  if (note === null) return;
  try {
    const payload = await apiJson("/api/knowledge-proposals/review", {
      method: "POST",
      body: JSON.stringify({ proposalId, action, note, reviewedBy: "workbench-web" })
    });
    window.alert(`已${label}：${payload?.newStatus ?? ""}\n审计日志已更新。`);
    await loadKnowledgeProposalList();
  } catch (error) {
    window.alert(`${label}失败：${escapeHtml(error?.message ?? String(error))}`);
  }
}


async function loadProposalWriteBackDiff(proposalId) {
  const target = $("knowledgeProposalWriteBackDiff");
  if (!target || !proposalId) return;
  target.hidden = false;
  target.innerHTML = `<div class="empty-card">正在计算写回 diff。</div>`;
  try {
    const diff = await apiJson(`/api/knowledge-proposals/write-back-diff?proposalId=${encodeURIComponent(proposalId)}`);
    if (!diff?.supported) {
      target.innerHTML = `<div class="empty-card">${escapeHtml(diff?.note ?? "该 proposal 暂无写回预览。")}</div>`;
      return;
    }
    const protections = Array.isArray(diff?.protections) ? diff.protections : [];
    target.innerHTML = `
      <div class="knowledge-map-head">
        <div>
          <h4>写回预览：${escapeHtml(diff.action ?? "")} ${escapeHtml(diff.pageId ?? "")}</h4>
          <p class="muted">新增元素 ${escapeHtml(String(diff?.newElements?.length ?? 0))} 个，断言候选 ${escapeHtml(String(diff?.newAssertions?.length ?? 0))} 组，状态上限 ${escapeHtml(diff?.statusCap ?? "candidate")}。</p>
        </div>
      </div>
      <ul class="proposal-writeback-protections">
        ${protections.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
      </ul>`;
  } catch (error) {
    target.innerHTML = `<div class="empty-card">写回 diff 计算失败：${escapeHtml(error?.message ?? String(error))}</div>`;
  }
}

document.addEventListener("click", (event) => {
  const mask = event.target.closest(".account-password-mask");
  if (!mask) return;
  const real = mask.nextElementSibling;
  if (!real || real.hidden === undefined) return;
  const show = real.hidden;
  real.hidden = !show;
  mask.textContent = show ? real.textContent : "••••••";
  mask.style.color = show ? "var(--color-text, #333)" : "";
});
