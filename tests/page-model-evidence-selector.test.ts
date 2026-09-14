import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFundsCenterIntent, selectEvidenceFromPageModelStore } from "../src/core/page-model-evidence-selector.js";
import { registerDemoIntentRouting } from "./fixtures/demo-intent-routing.js";
registerDemoIntentRouting();

const spotGiftRequest = "登录 Demo test 环境，进入现货账户资金流水页面，通过类型筛选，类型选择“赠币”，断言筛选结果展示赠币类型记录或空状态。";

test("classifies spot fund flow gift filter as read intent", () => {
  const intent = parseFundsCenterIntent(spotGiftRequest);

  assert.equal(intent.module, "asset");
  assert.equal(intent.action, "spot_fund_flow_filter");
  assert.equal(intent.operationType, "read");
  assert.equal(intent.data.type, "赠币");
  assert.equal(intent.loginRequired, true);
});

test("classifies normal Chinese red packet issued as spot fund flow type value, not red packet create", () => {
  const request = "\u767b\u5f55demo test\u73af\u5883\uff0c\u8fdb\u5165\u73b0\u8d27\u6d41\u6c34\u9875\u9762\uff0c\u7c7b\u578b\u9009\u62e9\u7ea2\u5305\u53d1\u653e\u8fdb\u884c\u641c\u7d22";
  const intent = parseFundsCenterIntent(request);

  assert.equal(intent.module, "asset");
  assert.equal(intent.action, "spot_fund_flow_filter");
  assert.equal(intent.operationType, "read");
  assert.equal(intent.data.type, "\u7ea2\u5305\u53d1\u653e");
});

test("keeps red packet create guard intent when assertion mentions phone and Google verification", () => {
  const request = "登录 demo test 环境，用例标题：红包-未开启安全验证创建被拦截\n业务步骤：\n1. 登录 demo test 环境未绑定 Google 且未绑定手机的新账号。\n2. 进入资产中心-红包。\n3. 点击创建红包\n期望断言：页面出现“提示”弹窗，提示至少开启手机验证码或谷歌验证码任一验证方式，并展示“去开启”入口。";
  const intent = parseFundsCenterIntent(request);

  assert.equal(intent.module, "red-packet");
  assert.equal(intent.action, "create_red_packet");
  assert.equal(intent.operationType, "write");
});

test("classifies red packet record status filter as record read intent instead of claim", () => {
  const request = "登录 demo test 环境，用例标题：红包记录-按已领取状态筛选\n业务步骤：\n1. 进入红包记录页面。\n2. 状态下拉框选择“已领取”。\n3. 点击查询\n期望断言：列表“状态”列仅返回“已领取”。";
  const intent = parseFundsCenterIntent(request);

  assert.equal(intent.module, "red-packet");
  assert.equal(intent.action, "view_red_packet_records");
  assert.equal(intent.operationType, "read");
  assert.equal(intent.data.status, "已领取");
  assert.equal(intent.data.passphrase, undefined);
});

test("classifies red packet records page view as read intent when assertion mentions issued records", () => {
  const request = "登录 demo test 环境，用例标题：红包记录-进入记录页后展示列表\n业务步骤：\n1. 进入红包页面。\n2. 点击“红包记录”。\n期望断言：领取记录和发放记录列表区域可见。";
  const intent = parseFundsCenterIntent(request);

  assert.equal(intent.module, "red-packet");
  assert.equal(intent.action, "view_red_packet_records");
  assert.equal(intent.operationType, "read");
});

test("keeps earn fund flow product type separate from transaction type", () => {
  const request = "登录 demo test 环境，用例标题：理财流水-按活期理财筛选\n业务步骤：\n1. 进入理财流水页面。\n2. 产品类型下拉框选择“活期理财”。\n3. 点击查询\n期望断言：列表“产品类型”列仅返回“活期理财”。";
  const intent = parseFundsCenterIntent(request);

  assert.equal(intent.module, "asset");
  assert.equal(intent.action, "earn_fund_flow_filter");
  assert.equal(intent.operationType, "read");
  assert.equal(intent.data.productType, "活期理财");
  assert.equal(intent.data.recordType, undefined);
  assert.equal(intent.data.type, undefined);
});

test("classifies finance account position view as read intent", () => {
  const request = "登录 demo test 环境，进入资产中心-理财账户页面，期望理财持仓列表展示币种、产品名称、总金额和操作列。";
  const intent = parseFundsCenterIntent(request);

  assert.equal(intent.module, "asset");
  assert.equal(intent.action, "earn_position_view");
  assert.equal(intent.operationType, "read");
  assert.equal(intent.data.entry, "asset_earn_account");
});

test("keeps finance account auto-subscribe state read out of subscribe write intent", () => {
  const request = "登录 demo test 环境，进入资产中心-理财账户页面，读取 ZEC 持仓行自动申购开关状态，不执行切换，期望状态来源为 aria-checked 或 data-state。";
  const intent = parseFundsCenterIntent(request);

  assert.equal(intent.module, "asset");
  assert.equal(intent.action, "earn_position_view");
  assert.equal(intent.operationType, "read");
  assert.equal(intent.data.asset, "ZEC");
});

test("honors DeepSeek read intent for finance account position list without subscribe amount gap", () => {
  const request = "登录 demo test 环境，用例标题：理财账户-进入页面后展示持仓列表\n模块：资产中心/理财账户\n期望断言：理财持仓列表展示币种/产品名称、总金额、累计收益、昨日收益、预期年化收益、自动申购和操作列。";
  const selection = selectEvidenceFromPageModelStore({
    request,
    store: fixtureStore(),
    project: "demo",
    env: "test",
    deepSeekIntent: {
      pageIntent: "资产中心-理财账户页面",
      businessAction: "进入资产中心-理财账户页面并查看理财持仓列表区域",
      operationType: "read",
      extractedData: {},
      expectedOutcome: "理财持仓列表页面可见，并展示自动申购和操作列",
      confidence: 0.92
    }
  });

  assert.equal(selection.intent.module, "asset");
  assert.equal(selection.intent.action, "earn_position_view");
  assert.equal(selection.intent.operationType, "read");
  assert.equal(selection.gaps.some((gap) => gap.startsWith("earn_subscribe_amount_value")), false);
});

test("classifies batch redeem modal inspection as read intent without redeem amount gap", () => {
  const request = "登录 demo test 环境，进入资产中心-理财账户页面，点击列表级批量赎回按钮，查看弹窗中的资产和余额字段，期望批量赎回弹窗不展示任何可编辑的赎回数量输入框。";
  const selection = selectEvidenceFromPageModelStore({
    request,
    store: fixtureStore(),
    project: "demo",
    env: "test",
    deepSeekIntent: {
      pageIntent: "资产中心-理财账户页面，列表及批量赎回弹窗",
      businessAction: "点击列表级批量赎回按钮，查看弹窗中的资产和余额字段",
      operationType: "read",
      extractedData: {},
      expectedOutcome: "批量赎回弹窗正常打开，且不展示任何可编辑的赎回数量输入框",
      confidence: 0.9
    }
  });

  assert.equal(selection.intent.action, "earn_batch_redeem_modal_view");
  assert.equal(selection.intent.operationType, "read");
  assert.equal(selection.gaps.some((gap) => gap.startsWith("earn_redeem_amount_value")), false);
});

test("does not require UID value when withdraw address case explicitly keeps UID empty", () => {
  const request = "登录 demo test 环境，进入提现地址管理页面，点击添加地址，切换为站内地址，UID 保持为空，期望保存地址按钮置灰。";
  const intent = parseFundsCenterIntent(request);
  const selection = selectEvidenceFromPageModelStore({
    request,
    project: "demo",
    env: "test",
    store: {
      project: "demo",
      models: [
        {
          pageId: "demo.funds.withdraw",
          project: "demo",
          pageName: "提币",
          status: "dom_verified",
          elements: []
        },
        {
          pageId: "demo.funds.withdraw.address_management",
          project: "demo",
          pageName: "提币地址管理",
          status: "dom_verified",
          elements: [
            { elementId: "funds.withdraw.address_management.add_address_button", semanticName: "添加地址", role: "button", controlType: "button", targetField: "action", status: "dom_verified" },
            { elementId: "funds.withdraw.add_address.internal_address_mode", semanticName: "站内地址页签", role: "tab", controlType: "tab", targetField: "address_type", status: "dom_verified" },
            { elementId: "funds.withdraw.add_address.internal_uid_input", semanticName: "站内 UID 输入框", role: "textbox", controlType: "input", targetField: "uid", status: "dom_verified" },
            { elementId: "funds.withdraw.add_address.save_button", semanticName: "保存地址按钮", role: "button", controlType: "button", targetField: "action", status: "dom_verified" }
          ],
          assertions: [
            { assertionId: "funds.withdraw.add_address.save_button.empty_uid_disabled", semanticName: "UID 为空时保存地址按钮置灰", assertionType: "element_disabled", status: "dom_verified" }
          ]
        }
      ]
    }
  });

  assert.equal(intent.action, "add_withdraw_address");
  assert.equal(intent.data.uidPolicy, "empty");
  assert.equal(selection.gaps.includes("withdraw_address_management_uid_value"), false);
});

test("keeps negative withdraw amount validation out of provider and address-management flow", () => {
  const request = "登录 demo test 环境，进入提现页面，币种选择 USDT，网络选择 BSC(BEP-20)，提现地址输入 0x000000000000000000000000000000000000dEaD，提现数量输入 0.00000001 USDT，期望页面提示金额低于最小提现额，或提交按钮保持不可提交状态。";
  const selection = selectEvidenceFromPageModelStore({
    request,
    project: "demo",
    env: "test",
    store: {
      project: "demo",
      models: [
        {
          pageId: "demo.funds.withdraw",
          project: "demo",
          pageName: "提币",
          status: "dom_verified",
          elements: [
            { elementId: "funds.withdraw.network_selector", semanticName: "提币网络下拉框", controlType: "dropdown", targetField: "network", status: "dom_verified" },
            { elementId: "funds.withdraw.network_selector.option.bsc", semanticName: "提币网络下拉框选项：BSC(BEP-20)", controlType: "dropdown_option", targetField: "network", optionValue: "BSC(BEP-20)", status: "dom_verified" },
            { elementId: "funds.withdraw.address_input", semanticName: "提币地址输入框", controlType: "input", targetField: "address", status: "dom_verified" },
            { elementId: "funds.withdraw.amount_input", semanticName: "提币数量输入框", controlType: "input", targetField: "amount", status: "dom_verified" },
            { elementId: "funds.withdraw.address_management_entry", semanticName: "提币地址管理入口", controlType: "button", targetField: "action", status: "dom_verified" },
            { elementId: "funds.withdraw.security.email_code_input", semanticName: "提现邮箱验证码输入框", controlType: "input", targetField: "email_code", status: "dom_verified" }
          ],
          assertions: [
            { assertionId: "funds.withdraw.submit_failure_or_precondition_signal", semanticName: "提现提交失败或前置条件提示", assertionType: "failure_signal", status: "dom_verified" }
          ]
        }
      ]
    }
  });

  assert.equal(selection.intent.action, "submit_withdraw");
  assert.equal(selection.intent.data.amountPolicy, "below_minimum");
  assert.equal(selection.selectedEvidence.some((item) => /address_management|email_code/i.test(item.id)), false);
  assert.equal(selection.gaps.some((gap) => /verification_provider|success_assertion|record_assertion/.test(gap)), false);
});

test("maps demo earn fund flow redeem wording to principal and earnings return option", () => {
  const request = "登录 demo test 环境，用例标题：理财流水-按赎回筛选返回匹配记录\n业务步骤：\n1. 进入理财流水页面。\n2. 交易类型下拉框选择“赎回”。\n3. 点击查询\n期望断言：列表“交易类型”列仅返回“赎回”。";
  const selection = selectEvidenceFromPageModelStore({
    request,
    project: "demo",
    env: "test",
    store: {
      project: "demo",
      models: [
        model("demo.funds.earn_fund_flow", "理财流水", "asset", "earn_fund_flow_filter", [
          fieldElement("funds.earn_fund_flow.transaction_type_filter", "理财流水交易类型筛选", "record_type"),
          fieldOption("funds.earn_fund_flow.transaction_type_filter.option.本金及收益返还", "理财流水交易类型选项：本金及收益返还", "record_type", "本金及收益返还"),
          fieldElement("funds.earn_fund_flow.query_button", "理财流水查询按钮", "action")
        ], [
          assertion("funds.earn_fund_flow.result_list_or_empty", "理财流水结果列表或空状态", "execution_verified")
        ])
      ]
    }
  });

  assert.equal(selection.intent.action, "earn_fund_flow_filter");
  assert.equal(selection.intent.data.recordType, "赎回");
  assert.equal(selection.gaps.some((gap) => gap.includes("赎回")), false);
  assert.ok(selection.selectedEvidence.some((item) => item.id.includes("本金及收益返还")));
});

test("does not treat earn product list assertion as subscribe action", () => {
  const request = "登录 demo test 环境，用例标题：理财-进入产品中心后展示产品列表\n业务步骤：\n1. 从首页打开更多菜单。\n2. 进入理财产品中心页面\n期望断言：理财产品列表展示币种为 SOL、产品名称为 SOL、状态为进行中的产品行，并展示该行可点击的“申购”按钮。";
  const selection = selectEvidenceFromPageModelStore({
    request,
    store: fixtureStore(),
    project: "demo",
    env: "test",
    deepSeekIntent: {
      pageIntent: "更多-理财产品中心页面",
      businessAction: "查看理财产品列表并确认 SOL 行申购按钮可见",
      operationType: "read",
      extractedData: { asset: "SOL", productName: "SOL", status: "进行中" },
      expectedOutcome: "产品列表中可见 SOL 行和申购按钮",
      confidence: 0.92
    }
  });

  assert.equal(selection.intent.module, "asset");
  assert.equal(selection.intent.action, "earn_product_view");
  assert.equal(selection.intent.operationType, "read");
  assert.equal(selection.intent.data.asset, "SOL");
  assert.equal(selection.gaps.some((gap) => gap.startsWith("earn_subscribe_amount_value")), false);
});

test("keeps current earn product center list case as read when row subscribe button is only asserted", () => {
  const request = "登录 demo test 环境，用例标题：理财-进入产品中心后展示产品列表，业务步骤：\n1. 从首页打开更多菜单。\n2. 进入理财产品中心页面。\n3. 查看活期理财产品列表，期望断言：\n理财产品列表展示币种为 USDT、产品名称为 USDT新理财、状态为进行中的产品行，并展示该行可点击的“申购”按钮。";
  const selection = selectEvidenceFromPageModelStore({
    request,
    store: fixtureStore(),
    project: "demo",
    env: "test",
    deepSeekIntent: {
      pageIntent: "demo test 环境理财产品中心中的活期理财产品列表页面",
      businessAction: "查看活期理财产品列表，并验证目标产品行及申购按钮",
      operationType: "read",
      extractedData: {
        productListCriteria: { coin: "USDT", productName: "USDT新理财", status: "进行中" },
        rowAction: "申购"
      },
      expectedOutcome: "success：理财产品列表区域可见；列表中存在币种为 USDT、产品名称为 USDT新理财、状态为进行中的产品行，且该行“申购”按钮可见并可点击",
      confidence: 0.95
    }
  });

  assert.equal(selection.intent.module, "asset");
  assert.equal(selection.intent.action, "earn_product_view");
  assert.equal(selection.intent.operationType, "read");
  assert.equal(selection.gaps.some((gap) => gap.startsWith("earn_subscribe_amount_value")), false);
});

test("preserves DeepSeek read over local write noise when no explicit execution cue exists", () => {
  const request = "登录 demo test 环境，进入更多-理财页面，查看活期理财产品列表，断言目标产品行的申购按钮可点击。";
  const selection = selectEvidenceFromPageModelStore({
    request,
    store: fixtureStore(),
    project: "demo",
    env: "test",
    deepSeekIntent: {
      pageIntent: "更多-理财产品中心页面",
      businessAction: "查看产品行并观察申购按钮状态",
      operationType: "read",
      extractedData: { asset: "USDT", rowAction: "申购" },
      expectedOutcome: "目标产品行的申购按钮可见且可点击",
      confidence: 0.93
    }
  });

  assert.equal(selection.intent.action, "earn_product_view");
  assert.equal(selection.intent.operationType, "read");
  assert.equal(selection.intentArbitration?.selectedSource, "deepseek_initial_intent");
  assert.equal(selection.blockingGaps.some((gap) => gap.startsWith("intent_arbitration_conflict")), false);
});

test("keeps earn subscribe intent when product center steps click subscribe and leave amount empty", () => {
  const request = "登录 demo test 环境，用例标题：理财-申购数量为空时确认按钮置灰\n业务步骤：\n1. 进入更多-理财页面。\n2. 定位币种为 SOL、产品名称为 SOL、状态为进行中的活期理财产品行。\n3. 点击该行右侧“申购”按钮。\n4. 申购数量保持为空。\n期望断言：申购弹窗中“确认”按钮置灰且不可点击。";
  const intent = parseFundsCenterIntent(request);

  assert.equal(intent.module, "asset");
  assert.equal(intent.action, "earn_subscribe");
  assert.equal(intent.operationType, "write");
  assert.equal(intent.data.asset, "SOL");
  assert.equal(intent.data.amountPolicy, "empty");
});

test("keeps earn subscribe intent when product center steps input boundary amount and confirm", () => {
  const request = "登录 demo test 环境，用例标题：理财-低于最小申购数量时申购失败\n业务步骤：\n1. 进入更多-理财页面。\n2. 定位币种为 SOL、产品名称为 SOL、状态为进行中的活期理财产品行。\n3. 点击该行右侧“申购”按钮。\n4. 申购数量输入“0.5 SOL”。\n5. 点击确认。\n期望断言：页面提示低于最小申购数量。";
  const intent = parseFundsCenterIntent(request);

  assert.equal(intent.module, "asset");
  assert.equal(intent.action, "earn_subscribe");
  assert.equal(intent.operationType, "write");
  assert.equal(intent.data.asset, "SOL");
  assert.equal(intent.data.amount, 0.5);
});

test("keeps more-earn subscribe evidence scoped to product center instead of finance account", () => {
  const request = "登录 demo test 环境，用例标题：理财-低于最小申购数量时申购失败\n业务步骤：\n1. 进入更多-理财页面。\n2. 定位币种为 SOL、产品名称为 SOL、状态为进行中的活期理财产品行。\n3. 点击该行右侧“申购”按钮。\n4. 申购数量输入“0.5 SOL”。\n5. 点击确认。\n期望断言：页面提示低于最小申购数量。";
  const store = fixtureStore();
  store.models.push(
    model("demo.earn.product_center", "更多-理财", "asset", "earn_subscribe", [
      element("earn_product_center.product_list.row_action.subscribe_by_asset", "目标产品行内申购按钮"),
      fieldElement("earn_product_center.subscribe_modal.amount_input", "申购数量输入框", "amount"),
      element("earn_product_center.subscribe_modal.confirm_button", "申购弹窗确认按钮")
    ], []),
    model("demo.funds.finance_account", "资产中心-理财账户", "asset", "earn_subscribe", [
      element("finance_account.row_action.subscribe", "理财账户目标币种行内申购按钮"),
      fieldElement("finance_account.subscribe.amount_input", "理财申购数量输入框", "amount"),
      element("finance_account.subscribe.confirm_button", "理财申购弹窗确认按钮")
    ], [])
  );
  const selection = selectEvidenceFromPageModelStore({ request, store, project: "demo", env: "test" });

  assert.equal(selection.intent.action, "earn_subscribe");
  assert.equal(selection.selectedEvidence.some((item) => item.pageId === "demo.funds.finance_account"), false);
  assert.equal(selection.selectedEvidence.some((item) => item.pageId === "demo.earn.product_center"), true);
});

test("prioritizes DeepSeek red packet page context over security-word personal-center noise", () => {
  const request = "登录 demo test 环境，用例标题：红包-未开启安全验证创建被拦截\n业务步骤：进入资产中心-红包，点击创建红包\n期望断言：提示至少开启手机验证码或谷歌验证码任一验证方式，并展示去开启入口。";
  const store = fixtureStore();
  store.models.push(
    model("demo.funds.red_packet", "资产中心-红包", "red-packet", "create_red_packet", [
      element("funds.red_packet.create.entry_button", "创建红包")
    ], [
      assertion("funds.red_packet.security_method_required_modal", "至少开启手机验证码或谷歌验证码任一验证方式")
    ])
  );

  const selection = selectEvidenceFromPageModelStore({
    request,
    store,
    project: "demo",
    env: "test",
    deepSeekIntent: {
      pageIntent: "资产中心-红包创建页面",
      businessAction: "使用未绑定手机和谷歌验证的新账号创建红包，验证应被拦截并提示开启验证方式",
      operationType: "write",
      extractedData: {},
      expectedOutcome: "弹出提示窗口，提示需开启手机验证码或谷歌验证码任一验证方式",
      confidence: 0.93
    }
  });

  assert.equal(selection.intent.module, "red-packet");
  assert.equal(selection.intent.action, "create_red_packet");
  assert.notEqual(selection.intent.module, "personal");
  assert.equal(selection.blockingGaps.some((gap) => gap.startsWith("intent_arbitration_conflict")), false);
});

test("classifies contract fund flow transfer as record type value instead of transfer write", () => {
  const request = "\u767b\u5f55 demo test \u73af\u5883\uff0c\u8fdb\u5165\u5408\u7ea6\u6d41\u6c34\u9875\u9762\uff0c\u7c7b\u578b\u9009\u62e9\u5212\u8f6c\u8fdb\u884c\u641c\u7d22\uff0c\u671f\u671b\u5217\u8868\u4e2d\u7c7b\u578b\u8fd4\u56de\u5212\u8f6c\u7684\u6570\u636e";
  const intent = parseFundsCenterIntent(request);

  assert.equal(intent.module, "asset");
  assert.equal(intent.action, "contract_fund_flow_filter");
  assert.equal(intent.operationType, "read");
  assert.equal(intent.data.recordType, "\u5212\u8f6c");
});

test("classifies earn account redeem with coupled amount and asset as write intent", () => {
  const request = "登录 demo test 环境，进入资产中心-理财账户，赎回5SOL，期望出现弹窗提示赎回成功";
  const intent = parseFundsCenterIntent(request);

  assert.equal(intent.module, "asset");
  assert.equal(intent.action, "earn_redeem");
  assert.equal(intent.operationType, "write");
  assert.equal(intent.data.asset, "SOL");
  assert.equal(intent.data.amount, 5);
});

test("keeps requested earn product asset from DeepSeek product field and blocks mismatched row action", () => {
  const request = "进入更多-理财页面，定位 zec 产品行，点击 zec右侧“申购”按钮，申购数量保持为空";
  const store = fixtureStore();
  store.models.push(
    model("demo.earn.product_center", "更多-理财", "asset", "earn_subscribe", [
      {
        ...element("earn_product_center.product_list.sol_row_subscribe_button", "SOL 产品行内申购按钮"),
        semanticRole: "row_action_button",
        targetField: "action",
        rowScope: { value: "SOL", actionText: "申购" },
        locatorCandidates: [{ strategy: "rowScoped", value: "rowScoped=value:SOL|actionText:申购" }]
      },
      element("earn_product_center.subscribe.amount_input", "申购数量输入框"),
      element("earn_product_center.subscribe.confirm_button", "申购弹窗确认按钮")
    ], [
      assertion("earn_product_center.subscribe.confirm_disabled", "确认按钮置灰", "dom_verified")
    ])
  );

  const selection = selectEvidenceFromPageModelStore({
    request,
    store,
    project: "demo",
    env: "test",
    deepSeekIntent: {
      pageIntent: "更多-理财页面",
      businessAction: "定位 zec 产品行并点击申购按钮",
      operationType: "write",
      extractedData: { product: "zec" },
      expectedOutcome: "确认按钮置灰",
      confidence: 0.92
    }
  });

  assert.equal(selection.intent.data.asset, "ZEC");
  assert.equal(selection.selectedEvidence.some((item) => item.id === "earn_product_center.product_list.sol_row_subscribe_button"), false);
  assert.equal(selection.executable, false);
  assert.ok(selection.blockingGaps.includes("earn_subscribe_row_action_for_asset:ZEC"));
});

test("accepts dynamic earn product row action template for volatile listed assets", () => {
  const request = "进入更多-理财页面，定位 zec 产品行，点击 zec右侧“申购”按钮，申购数量保持为空，期望确认按钮置灰";
  const store = fixtureStore();
  store.models.push(
    model("demo.earn.product_center", "更多-理财", "asset", "earn_subscribe", [
      {
        ...element("earn_product_center.product_list.row_action.subscribe_by_asset", "目标产品行内申购按钮"),
        semanticRole: "row_action_button",
        targetField: "action",
        rowScope: { field: "asset", valueSource: "intent.data.asset", actionText: "申购", expandText: "查看更多" },
        locatorCandidates: [{ strategy: "row_scoped_text", value: "row contains {asset} >> button text 申购" }]
      },
      element("earn_product_center.subscribe.amount_input", "申购数量输入框"),
      element("earn_product_center.subscribe.confirm_button", "申购弹窗确认按钮")
    ], [
      assertion("earn_product_center.subscribe.confirm_disabled", "确认按钮置灰", "dom_verified")
    ])
  );

  const selection = selectEvidenceFromPageModelStore({
    request,
    store,
    project: "demo",
    env: "test",
    deepSeekIntent: {
      pageIntent: "更多-理财页面",
      businessAction: "定位 zec 产品行并点击申购按钮",
      operationType: "write",
      extractedData: { product: "zec" },
      expectedOutcome: "确认按钮置灰",
      confidence: 0.92
    }
  });

  assert.equal(selection.intent.data.asset, "ZEC");
  assert.equal(selection.executable, true);
  assert.equal(selection.gaps.includes("earn_subscribe_asset_scope:ZEC"), false);
  assert.equal(selection.gaps.includes("earn_subscribe_row_action_for_asset:ZEC"), false);
  assert.ok(selection.selectedEvidence.some((item) => item.id === "earn_product_center.product_list.row_action.subscribe_by_asset"));
});

test("extracts fund flow type value after dropdown wording", () => {
  const request = "\u767b\u5f55 demo test \u73af\u5883\uff0c\u8fdb\u5165\u5408\u7ea6\u6d41\u6c34\u9875\u9762\uff0c\u4ea4\u6613\u7c7b\u578b\u4e0b\u62c9\u6846\u9009\u62e9\u201c\u8f6c\u5165\u201d\u8fdb\u884c\u67e5\u8be2\uff0c\u671f\u671b\u5217\u8868\u4e2d\u4ec5\u8fd4\u56de\u7c7b\u578b\u4e3a\u201c\u8f6c\u5165\u201d\u7684\u6570\u636e";
  const intent = parseFundsCenterIntent(request);

  assert.equal(intent.module, "asset");
  assert.equal(intent.action, "contract_fund_flow_filter");
  assert.equal(intent.operationType, "read");
  assert.equal(intent.data.recordType, "\u8f6c\u5165");
});

test("reports a Page Model gap when requested spot fund flow type option is not modeled", () => {
  const request = "\u767b\u5f55demo test\u73af\u5883\uff0c\u8fdb\u5165\u73b0\u8d27\u6d41\u6c34\u9875\u9762\uff0c\u7c7b\u578b\u9009\u62e9\u7ea2\u5305\u53d1\u653e\u8fdb\u884c\u641c\u7d22";
  const store = fixtureStore();
  store.models.push(
    model("demo.funds.spot_fund_flow", "\u73b0\u8d27\u8d44\u91d1\u6d41\u6c34", "asset", "spot_fund_flow_filter", [
      element("p7.spot_fund_flow.type_filter", "\u7c7b\u578b\u7b5b\u9009\u63a7\u4ef6"),
      element("p7.spot_fund_flow.gift_coin_option", "\u8d60\u5e01\u7c7b\u578b\u9009\u9879"),
      element("p7.spot_fund_flow.query_button", "\u67e5\u8be2\u6309\u94ae"),
      element("p7.spot_fund_flow.result_list", "\u8d44\u91d1\u6d41\u6c34\u7ed3\u679c\u5217\u8868")
    ], [
      assertion("p7.spot_fund_flow.result_gift_or_empty", "list_or_empty_state \u8d60\u5e01 \u6682\u65e0\u6570\u636e", "dom_verified")
    ])
  );

  const selection = selectEvidenceFromPageModelStore({
    request,
    store,
    project: "demo",
    env: "test"
  });

  assert.equal(selection.intent.module, "asset");
  assert.equal(selection.executable, false);
  assert.ok(selection.gaps.includes("spot_fund_flow_type_filter_option:\u7ea2\u5305\u53d1\u653e"));
  assert.equal(selection.selectedEvidence.some((item) => /red[_-]?packet|create/i.test(`${item.id} ${item.semanticName ?? ""}`)), false);
});

test("selects spot account and fund flow evidence but keeps gift filter gaps", () => {
  const selection = selectEvidenceFromPageModelStore({
    request: spotGiftRequest,
    store: fixtureStore(),
    project: "demo",
    env: "test"
  });

  assert.equal(selection.intent.module, "asset");
  assert.equal(selection.readiness, "partial");
  assert.equal(selection.executable, false);
  assert.ok(selection.selectedEvidence.some((item) => item.pageId === "demo.funds.spot_account"));
  assert.ok(selection.selectedEvidence.some((item) => item.pageId === "demo.funds.fund_flow_entry"));
  assert.ok(selection.gaps.some((gap) => gap.startsWith("spot_fund_flow_type_filter_option")));
  assert.ok(selection.gaps.includes("spot_fund_flow_result_assertion"));
});

test("uses verified spot fund flow page model to close gift filter gaps", () => {
  const store = fixtureStore();
  store.models.push(
    model("demo.funds.spot_fund_flow", "\u73b0\u8d27\u8d44\u91d1\u6d41\u6c34", "asset", "spot_fund_flow_filter", [
      fieldElement("funds.spot_fund_flow.type_filter", "\u7c7b\u578b\u7b5b\u9009\u63a7\u4ef6", "record_type"),
      fieldOption("funds.spot_fund_flow.type_filter.option.\u8d60\u5e01", "\u7c7b\u578b\u7b5b\u9009\u9009\u9879:\u8d60\u5e01", "record_type", "\u8d60\u5e01"),
      element("funds.spot_fund_flow.result_list", "\u8d44\u91d1\u6d41\u6c34\u7ed3\u679c\u5217\u8868")
    ], [
      assertion("funds.spot_fund_flow.observable.result_list_or_empty", "list_or_empty_state \u8d60\u5e01 \u6682\u65e0\u6570\u636e", "dom_verified")
    ])
  );

  const selection = selectEvidenceFromPageModelStore({
    request: spotGiftRequest,
    store,
    project: "demo",
    env: "test"
  });

  assert.equal(selection.readiness, "ready");
  assert.equal(selection.executable, true);
  assert.ok(selection.selectedEvidence.some((item) => item.pageId === "demo.funds.spot_fund_flow"));
  const resultListEvidence = selection.selectedEvidence.find((item) => item.id === "funds.spot_fund_flow.result_list");
  assert.equal(resultListEvidence?.evidenceRole, "assertion");
  assert.equal(resultListEvidence?.executionAllowed, true);
  assert.ok(selection.evidenceBuckets.assertions.some((item) => item.id === "funds.spot_fund_flow.result_list"));
  assert.equal(selection.evidenceBuckets.executableElements.some((item) => item.id === "funds.spot_fund_flow.result_list"), false);
  assert.equal(selection.gaps.some((gap) => gap.startsWith("spot_fund_flow_type_filter_option")), false);
  assert.equal(selection.gaps.includes("spot_fund_flow_result_assertion"), false);
});

test("selects asset filter evidence without inventing a type filter", () => {
  const request = "\u767b\u5f55demo test\u73af\u5883\uff0c\u8fdb\u5165\u73b0\u8d27\u6d41\u6c34\u9875\u9762\uff0c\u5e01\u79cd\u4e0b\u62c9\u6846\u9009\u62e9\"ETH\"\u8fdb\u884c\u67e5\u8be2\uff0c\u671f\u671b\u5217\u8868\u8fd4\u56de\u7a7a";
  const store = fixtureStore();
  store.models.push(
    model("demo.funds.spot_fund_flow", "\u73b0\u8d27\u8d44\u91d1\u6d41\u6c34", "asset", "spot_fund_flow_filter", [
      fieldElement("w3.spot_fund_flow.asset_filter", "\u5e01\u79cd\u7b5b\u9009\u63a7\u4ef6", "asset"),
      fieldOption("w3.spot_fund_flow.asset_filter.option.eth", "\u5e01\u79cd\u7b5b\u9009\u9009\u9879:ETH", "asset", "ETH"),
      fieldElement("w3.spot_fund_flow.type_filter", "\u7c7b\u578b\u7b5b\u9009\u63a7\u4ef6", "record_type"),
      fieldOption("w3.spot_fund_flow.type_filter.option.\u5185\u90e8\u8f6c\u5165", "\u7c7b\u578b\u7b5b\u9009\u9009\u9879:\u5185\u90e8\u8f6c\u5165", "record_type", "\u5185\u90e8\u8f6c\u5165"),
      element("w3.spot_fund_flow.query_button", "\u67e5\u8be2\u6309\u94ae")
    ], [
      assertion("w3.spot_fund_flow.empty_state_visible", "\u7a7a\u72b6\u6001\u53ef\u89c1", "dom_verified")
    ])
  );

  const selection = selectEvidenceFromPageModelStore({ request, store, project: "demo", env: "test" });

  assert.equal(selection.intent.data.asset, "ETH");
  assert.equal(selection.intent.data.type, undefined);
  assert.equal(selection.intent.data.recordType, undefined);
  assert.equal(selection.readiness, "ready");
  assert.equal(selection.executable, true);
  assert.ok(selection.selectedEvidence.some((item) => item.id === "w3.spot_fund_flow.asset_filter.option.eth"));
  assert.equal(selection.selectedEvidence.some((item) => item.id.includes("type_filter")), false);
  assert.deepEqual(selection.gaps, []);
});

test("keeps concrete local slots when DeepSeek omits extracted filter values", () => {
  const request = "\u767b\u5f55demo test\u73af\u5883\uff0c\u8fdb\u5165\u73b0\u8d27\u6d41\u6c34\u9875\u9762\uff0c\u5e01\u79cd\u4e0b\u62c9\u6846\u9009\u62e9\"ETH\"\u8fdb\u884c\u67e5\u8be2\uff0c\u671f\u671b\u5217\u8868\u8fd4\u56de\u5e01\u79cd\u4e3aETH\u7684\u6570\u636e";
  const store = fixtureStore();
  store.models.push(
    model("demo.funds.spot_fund_flow", "\u73b0\u8d27\u8d44\u91d1\u6d41\u6c34", "asset", "spot_fund_flow_filter", [
      fieldElement("w3.spot_fund_flow.asset_filter", "\u5e01\u79cd\u7b5b\u9009\u63a7\u4ef6", "asset"),
      fieldOption("w3.spot_fund_flow.asset_filter.option.eth", "\u5e01\u79cd\u7b5b\u9009\u9009\u9879:ETH", "asset", "ETH"),
      element("w3.spot_fund_flow.query_button", "\u67e5\u8be2\u6309\u94ae")
    ], [
      assertion("w3.spot_fund_flow.result_list", "\u7ed3\u679c\u5217\u8868", "dom_verified")
    ])
  );

  const selection = selectEvidenceFromPageModelStore({
    request,
    store,
    project: "demo",
    env: "test",
    deepSeekIntent: {
      pageIntent: "\u73b0\u8d27\u6d41\u6c34\u9875\u9762",
      businessAction: "query spot transactions with ETH currency filter",
      operationType: "read",
      extractedData: {},
      expectedOutcome: "filtered rows where currency equals ETH",
      confidence: 0.95
    }
  });

  assert.equal(selection.intentArbitration?.selectedSource, "deepseek_initial_intent");
  assert.equal(selection.intent.data.asset, "ETH");
  assert.ok(selection.selectedEvidence.some((item) => item.id === "w3.spot_fund_flow.asset_filter.option.eth"));
  assert.equal(selection.gaps.some((gap) => gap.includes("asset_filter_option:ETH")), false);
});

test("reports an asset option gap instead of falling back to a type option", () => {
  const request = "\u767b\u5f55demo test\u73af\u5883\uff0c\u8fdb\u5165\u73b0\u8d27\u6d41\u6c34\u9875\u9762\uff0c\u5e01\u79cd\u4e0b\u62c9\u6846\u9009\u62e9\"ETH\"\u8fdb\u884c\u67e5\u8be2\uff0c\u671f\u671b\u5217\u8868\u8fd4\u56de\u7a7a";
  const store = fixtureStore();
  store.models.push(
    model("demo.funds.spot_fund_flow", "\u73b0\u8d27\u8d44\u91d1\u6d41\u6c34", "asset", "spot_fund_flow_filter", [
      fieldElement("w3.spot_fund_flow.asset_filter", "\u5e01\u79cd\u7b5b\u9009\u63a7\u4ef6", "asset"),
      fieldElement("w3.spot_fund_flow.type_filter", "\u7c7b\u578b\u7b5b\u9009\u63a7\u4ef6", "record_type"),
      fieldOption("w3.spot_fund_flow.type_filter.option.\u5185\u90e8\u8f6c\u5165", "\u7c7b\u578b\u7b5b\u9009\u9009\u9879:\u5185\u90e8\u8f6c\u5165", "record_type", "\u5185\u90e8\u8f6c\u5165"),
      element("w3.spot_fund_flow.query_button", "\u67e5\u8be2\u6309\u94ae")
    ], [
      assertion("w3.spot_fund_flow.empty_state_visible", "\u7a7a\u72b6\u6001\u53ef\u89c1", "dom_verified")
    ])
  );

  const selection = selectEvidenceFromPageModelStore({ request, store, project: "demo", env: "test" });

  assert.equal(selection.readiness, "partial");
  assert.equal(selection.executable, false);
  assert.ok(selection.gaps.includes("spot_fund_flow_asset_filter_option:ETH"));
  assert.equal(selection.selectedEvidence.some((item) => item.id.includes("type_filter.option")), false);
});

test("excludes transfer-record helper filters from ordinary spot fund flow type selection", () => {
  const request = "\u767b\u5f55demo test\u73af\u5883\uff0c\u8fdb\u5165\u73b0\u8d27\u6d41\u6c34\u9875\u9762\uff0c\u901a\u8fc7\u7c7b\u578b\u9009\u62e9\u8d60\u5e01\u8fdb\u884c\u641c\u7d22";
  const store = fixtureStore();
  store.models.push(
    model("demo.funds.spot_fund_flow", "\u73b0\u8d27\u8d44\u91d1\u6d41\u6c34", "asset", "spot_fund_flow_filter", [
      element("t2_5.transfer_record.asset_filter", "\u5e01\u79cd\u7b5b\u9009\u63a7\u4ef6"),
      element("t2_5.transfer_record.type_filter", "\u7c7b\u578b\u7b5b\u9009\u63a7\u4ef6"),
      element("t2_5.transfer_record.transfer_type_option", "\u5212\u8f6c\u7c7b\u578b\u9009\u9879"),
      fieldElement("w3.spot_fund_flow.type_filter", "\u7c7b\u578b\u7b5b\u9009\u63a7\u4ef6", "record_type"),
      fieldOption("w3.spot_fund_flow.type_filter.option.\u8d60\u5e01", "\u7c7b\u578b\u7b5b\u9009\u9009\u9879:\u8d60\u5e01", "record_type", "\u8d60\u5e01"),
      element("w3.spot_fund_flow.query_button", "\u67e5\u8be2\u6309\u94ae")
    ], [
      assertion("w3.spot_fund_flow.result_record_type_or_empty", "\u7ed3\u679c\u5217\u8868\u6216\u7a7a\u72b6\u6001", "dom_verified")
    ])
  );

  const selection = selectEvidenceFromPageModelStore({ request, store, project: "demo", env: "test" });

  assert.equal(selection.readiness, "ready");
  assert.equal(selection.selectedEvidence.some((item) => item.id.startsWith("t2_5.transfer_record")), false);
  assert.equal(selection.selectedEvidence.some((item) => item.id === "w3.spot_fund_flow.type_filter.option.\u8d60\u5e01"), true);
});

test("selects time filter only when the request includes a time range", () => {
  const request = "\u767b\u5f55demo test\u73af\u5883\uff0c\u8fdb\u5165\u73b0\u8d27\u6d41\u6c34\u9875\u9762\uff0c\u9009\u62e9\u4eca\u5929\u8fdb\u884c\u67e5\u8be2";
  const store = fixtureStore();
  store.models.push(
    model("demo.funds.spot_fund_flow", "\u73b0\u8d27\u8d44\u91d1\u6d41\u6c34", "asset", "spot_fund_flow_filter", [
      fieldElement("w3.spot_fund_flow.time_filter", "\u65f6\u95f4\u7b5b\u9009\u63a7\u4ef6", "time_range"),
      fieldElement("w3.spot_fund_flow.type_filter", "\u7c7b\u578b\u7b5b\u9009\u63a7\u4ef6", "record_type"),
      element("w3.spot_fund_flow.query_button", "\u67e5\u8be2\u6309\u94ae")
    ], [
      assertion("w3.spot_fund_flow.result_list_visible", "\u7ed3\u679c\u5217\u8868\u53ef\u89c1", "dom_verified")
    ])
  );

  const selection = selectEvidenceFromPageModelStore({ request, store, project: "demo", env: "test" });

  assert.deepEqual(selection.intent.data.timeRange, { raw: "\u4eca\u5929", mode: "relative" });
  assert.ok(selection.selectedEvidence.some((item) => item.id === "w3.spot_fund_flow.time_filter"));
  assert.equal(selection.selectedEvidence.some((item) => item.id === "w3.spot_fund_flow.type_filter"), false);
  assert.equal(selection.gaps.includes("spot_fund_flow_time_filter"), false);
});

test("selects transfer page model and exposes transfer form gaps", () => {
  const selection = selectEvidenceFromPageModelStore({
    request: "登录 Demo test 环境，进入划转页面，从现货账户划转到合约账户，币种选择 USDT，数量输入 50，完成划转提交，并断言划转成功，同时断言资金流水或相关记录中出现本次划转记录。",
    store: fixtureStore(),
    project: "demo",
    env: "test"
  });

  assert.equal(selection.intent.module, "transfer");
  assert.equal(selection.intent.operationType, "write");
  assert.equal(selection.intent.data.asset, "USDT");
  assert.equal(selection.intent.data.amount, 50);
  assert.equal(selection.readiness, "blocked_by_precondition");
  assert.ok(selection.selectedEvidence.some((item) => item.pageId === "demo.funds.transfer_entry"));
  assert.ok(selection.gaps.includes("transfer_submit_result_assertion"));
  assert.ok(selection.gaps.includes("transfer_record_assertion"));
});

test("selects withdraw page model and reports withdraw verification gaps", () => {
  const selection = selectEvidenceFromPageModelStore({
    request: "登录 Demo test 环境，进入提现页面，币种选择 USDT，链选择 BSC，提现地址输入 0x638d48Ed53860D7aE5dB19fE2Cce7B4616EdE8AD，按平台允许的最小或默认提现数量完成一次提现提交，并断言提交成功，同时断言提现记录中出现本次提现记录。",
    store: fixtureStore(),
    project: "demo",
    env: "test"
  });

  assert.equal(selection.intent.module, "withdraw");
  assert.equal(selection.intent.operationType, "write");
  assert.equal(selection.intent.data.asset, "USDT");
  assert.equal(selection.intent.data.network, "BSC");
  assert.equal(selection.readiness, "partial");
  assert.ok(selection.selectedEvidence.some((item) => item.pageId === "demo.funds.withdraw"));
  assert.ok(selection.gaps.includes("withdraw_chain_selector_bsc"));
  assert.ok(selection.gaps.includes("withdraw_verification_provider_state"));
  assert.ok(selection.gaps.includes("withdraw_record_assertion"));
});

test("does not bind withdraw address network value as asset", () => {
  const intent = parseFundsCenterIntent("登录 demo test 环境，进入提现-地址管理页面，点击添加地址，在添加地址弹窗中选择网络下拉框选择\"BSC(BEP-20)\"，提现地址输入\"0x638d48Ed53860D7aE5dB19fE2Cce7B4616EdE8AD\"，点击\"保存地址\"按钮");

  assert.equal(intent.module, "withdraw");
  assert.equal(intent.action, "add_withdraw_address");
  assert.equal(intent.data.asset, undefined);
  assert.equal(intent.data.network, "BSC(BEP-20)");
  assert.equal(intent.data.address, "0x638d48Ed53860D7aE5dB19fE2Cce7B4616EdE8AD");
});

test("treats withdraw address management as page context for add address operation", () => {
  const request = "\u767b\u5f55 demo test \u73af\u5883\uff0c\u8fdb\u5165\u8d44\u4ea7\u4e2d\u5fc3-\u63d0\u73b0-\u5730\u5740\u7ba1\u7406\u9875\u9762\uff0c\u70b9\u51fb\u6dfb\u52a0\u5730\u5740-\u7ad9\u5185\u5730\u5740\uff0cUID\u8f93\u516514605\uff0c\u70b9\u51fb\u4fdd\u5b58\u5730\u5740\uff0c\u5b8c\u6210\u53cc\u9a8c\u8bc1\u540e\u671f\u671b\u63d0\u793a\"\u8be5\u8d26\u53f7\u5df2\u5b58\u5728\"";
  const selection = selectEvidenceFromPageModelStore({
    request,
    store: fixtureStore(),
    project: "demo",
    env: "test",
    deepSeekIntent: {
      pageIntent: "\u63d0\u73b0\u5730\u5740\u7ba1\u7406\u9875\u9762",
      businessAction: "\u67e5\u770b\u5730\u5740\u7ba1\u7406\u9875\u9762",
      operationType: "read",
      extractedData: { UID: "14605" },
      confidence: 0.9
    }
  });

  assert.equal(selection.intent.module, "withdraw");
  assert.equal(selection.intent.action, "add_withdraw_address");
  assert.equal(selection.intent.operationType, "write");
  assert.equal(selection.intentArbitration?.conflicts.length, 0);
  assert.equal(selection.blockingGaps.some((gap) => gap.startsWith("intent_arbitration_conflict")), false);
});

test("keeps withdraw address management guard intent when security words appear", () => {
  const request = "登录 demo test 环境，用例标题：提币地址管理-未开启安全验证方式被拦截\n业务步骤：使用未绑定 Google 且未绑定手机的新账号，直接进入 /zh-hans/assets/address-manage 提币地址管理页面。\n期望断言：页面出现安全验证方式提示，提示至少开启手机验证码或谷歌验证码任一验证方式。";
  const store = fixtureStore();
  store.models.push(
    model("demo.funds.withdraw.address_management", "提币地址管理", "withdraw", "manage_withdraw_address", [
      element("withdraw_address_add_button", "添加地址")
    ], [
      assertion("withdraw_address.security_method_required_modal", "至少开启手机验证码或谷歌验证码任一验证方式")
    ], [
      block("withdraw_address_management.open_security_method_required_block")
    ])
  );
  const selection = selectEvidenceFromPageModelStore({
    request,
    store,
    project: "demo",
    env: "test",
    deepSeekIntent: {
      pageIntent: "提币地址管理页面（/zh-hans/assets/address-manage），用于管理提币地址并校验安全验证方式",
      businessAction: "登录未绑定 Google 且未绑定手机的新账号，直接访问提币地址管理页面，验证未开启安全验证方式时被拦截",
      operationType: "read",
      extractedData: { url: "/zh-hans/assets/address-manage" },
      expectedOutcome: "提示至少开启手机验证码或谷歌验证码任一验证方式",
      confidence: 0.95
    }
  });

  assert.equal(selection.intent.module, "withdraw");
  assert.equal(selection.intent.action, "manage_withdraw_address");
  assert.notEqual(selection.intent.module, "personal");
  assert.equal(selection.intentArbitration?.selectedSource, "deepseek_initial_intent");
  assert.equal(selection.intentArbitration?.conflicts.length, 0);
  assert.equal(selection.blockingGaps.some((gap) => gap.startsWith("intent_arbitration_conflict")), false);
});

test("keeps explicit personal security context as personal center intent", () => {
  const intent = parseFundsCenterIntent("登录 demo test 环境，进入个人中心-账号管理，查看谷歌验证码绑定状态。");

  assert.equal(intent.module, "personal");
  assert.equal(intent.action, "view_account_security");
});

function fixtureStore() {
  return {
    project: "demo",
    models: [
      model("demo.funds.spot_account", "现货账户", "asset", "spot_account", [
        element("spot_fund_flow_entry", "资金流水入口"),
        element("spot_asset_list", "资金列表 USDT")
      ], []),
      model("demo.funds.fund_flow_entry", "资金流水入口", "asset", "record", [
        element("fund_flow_entry", "资金流水")
      ], [
        assertion("fund_flow_page", "列表或空状态")
      ], [
        block("p4_block_fund_flow_entry_precondition")
      ]),
      model("demo.funds.transfer_entry", "划转入口", "transfer", "open", [
        element("transfer_entry", "划转"),
        element("transfer_asset", "币种 USDT")
      ], [
        assertion("transfer_state", "划转弹窗")
      ], [
        block("p4_block_transfer_entry_precondition")
      ]),
      model("demo.funds.withdraw", "提现", "withdraw", "open", [
        element("withdraw_asset", "币种 USDT"),
        element("withdraw_address", "提现地址"),
        element("withdraw_amount", "提币数量")
      ], [
        assertion("withdraw_table", "提现记录 暂无数据")
      ])
    ]
  };
}

function model(pageId: string, pageName: string, module: string, action: string, elements: unknown[], assertions: unknown[], blockedStates: unknown[] = []) {
  return {
    pageId,
    pageName,
    project: "demo",
    module,
    action,
    status: "dom_verified",
    confidence: 0.8,
    evidence: [{ source: "dom", path: `${pageId}.dom.html`, confidence: 0.75 }],
    elements,
    assertions,
    blockedStates
  };
}

function element(elementId: string, semanticName: string) {
  return {
    elementId,
    semanticName,
    role: "button",
    status: "dom_verified",
    confidence: 0.7,
    evidence: [{ source: "dom", path: `${elementId}.dom.html`, confidence: 0.7 }]
  };
}

function fieldElement(elementId: string, semanticName: string, targetField: string) {
  return {
    ...element(elementId, semanticName),
    targetField
  };
}

function fieldOption(elementId: string, semanticName: string, targetField: string, optionValue: string) {
  return {
    ...element(elementId, semanticName),
    role: "option",
    targetField,
    optionValue,
    parentElementId: targetField === "asset" ? "w3.spot_fund_flow.asset_filter" : "w3.spot_fund_flow.type_filter"
  };
}

function assertion(assertionId: string, semanticName: string, status = "candidate") {
  return {
    assertionId,
    assertionKind: semanticName,
    candidates: [{ type: "visible_text_any", expected: [semanticName] }],
    status,
    evidence: [{ source: "visible_text", path: `${assertionId}.txt`, confidence: 0.5 }]
  };
}

function block(blockId: string) {
  return {
    blockId,
    blockType: "blocked_by_precondition",
    status: "blocked",
    requiredHumanAction: "准备账号状态后继续。",
    evidence: [{ source: "screenshot", path: `${blockId}.png`, confidence: 0.6 }]
  };
}
