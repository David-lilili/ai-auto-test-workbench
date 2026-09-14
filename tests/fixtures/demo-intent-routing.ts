import { registerIntentPageRouting, type IntentLike, type ProjectIntentPageRouting } from "../../src/core/project-intent-routing.js";

/**
 * 测试用示例意图路由：演示"项目接入时注册自己的 ProjectIntentPageRouting"，
 * 覆盖理财/现货/合约流水、个人中心、红包、提现、理财申购/赎回等常见意图，
 * 页面 ID 使用示例项目 demo 的建模页面。
 */

function isWithdrawAddressManagementIntent(intent: IntentLike): boolean {
  return intent.action === "manage_withdraw_address" || intent.action === "add_withdraw_address" || intent.data.targetPage === "withdraw_address_management";
}

export const demoIntentPageRouting: ProjectIntentPageRouting = {
  project: "demo",

  targetPageIdsForIntent(intent: IntentLike): string[] {
    if (intent.module === "personal") {
      if (/api/i.test(intent.action) || intent.data.targetPage === "api_management") return ["demo.personal.api_management"];
      if (/kyc|identity/i.test(intent.action) || intent.data.targetPage === "kyc") return ["demo.personal.kyc"];
      return ["demo.personal.account"];
    }
    if (intent.module === "red-packet") return ["demo.funds.red_packet"];
    if (intent.module === "withdraw" && isWithdrawAddressManagementIntent(intent)) {
      return ["demo.funds.withdraw", "demo.funds.withdraw.address_management"];
    }
    if (intent.module === "withdraw") return ["demo.funds.withdraw"];
    if (intent.module === "transfer") return ["demo.funds.transfer_entry", "demo.funds.spot_fund_flow", "demo.funds.fund_flow_entry", "demo.asset.total_assets"];
    if (intent.module === "asset" && intent.action === "earn_redeem") {
      return ["demo.funds.finance_account"];
    }
    if (intent.module === "asset" && intent.action === "earn_subscribe") {
      return intent.data.entry === "asset_earn_account"
        ? ["demo.funds.finance_account"]
        : ["demo.earn.product_center"];
    }
    if (intent.module === "asset" && intent.action === "earn_product_view") {
      return ["demo.earn.product_center"];
    }
    if (intent.module === "asset" && (intent.action === "earn_position_view" || intent.action === "earn_batch_redeem_modal_view")) {
      return ["demo.funds.finance_account"];
    }
    if (intent.module === "asset" && intent.action === "earn_fund_flow_filter") {
      return ["demo.funds.finance_account", "demo.funds.fund_flow_entry", "demo.funds.earn_fund_flow"];
    }
    if (intent.module === "asset" && intent.action === "contract_fund_flow_filter") {
      return ["demo.funds.futures_account", "demo.funds.fund_flow_entry", "demo.funds.contract_fund_flow"];
    }
    if (intent.module === "asset" && intent.action === "spot_fund_flow_filter") {
      return ["demo.funds.spot_account", "demo.funds.fund_flow_entry", "demo.funds.spot_fund_flow"];
    }
    return [];
  },

  primaryTargetPageIdForIntent(intent: IntentLike): string | undefined {
    if (intent.module === "personal") return this.targetPageIdsForIntent(intent)[0];
    if (intent.module === "red-packet") return "demo.funds.red_packet";
    if (intent.module === "withdraw" && isWithdrawAddressManagementIntent(intent)) return "demo.funds.withdraw.address_management";
    if (intent.module === "withdraw") return "demo.funds.withdraw";
    if (intent.module === "transfer") return "demo.funds.transfer_entry";
    if (intent.module === "asset" && intent.action === "earn_redeem") return "demo.funds.finance_account";
    if (intent.module === "asset" && intent.action === "earn_subscribe") {
      return intent.data.entry === "asset_earn_account" ? "demo.funds.finance_account" : "demo.earn.product_center";
    }
    if (intent.module === "asset" && intent.action === "earn_product_view") return "demo.earn.product_center";
    if (intent.module === "asset" && (intent.action === "earn_position_view" || intent.action === "earn_batch_redeem_modal_view")) return "demo.funds.finance_account";
    if (intent.module === "asset" && intent.action === "earn_fund_flow_filter") return "demo.funds.earn_fund_flow";
    if (intent.module === "asset" && intent.action === "contract_fund_flow_filter") return "demo.funds.contract_fund_flow";
    if (intent.module === "asset" && intent.action === "spot_fund_flow_filter") return "demo.funds.spot_fund_flow";
    return undefined;
  },

  normalizeIntentValue(intent: IntentLike, value: string): string | undefined {
    if (intent.action === "earn_fund_flow_filter" && value === "赎回") return "本金及收益返还";
    return undefined;
  }
};

export function registerDemoIntentRouting(): void {
  registerIntentPageRouting(demoIntentPageRouting);
}
