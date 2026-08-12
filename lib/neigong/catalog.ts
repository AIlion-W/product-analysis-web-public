export const DIMENSIONS = ["persona", "scene", "painPoint", "detail", "effect", "delight"] as const;

export const DIMENSION_LABELS: Record<(typeof DIMENSIONS)[number], string> = {
  persona: "人群身份",
  scene: "使用场景",
  painPoint: "核心痛点",
  detail: "体验细节",
  effect: "效果反馈",
  delight: "意外惊喜",
};

export const TAXONOMY = [
  { id: "t1", name: "纯功效陈述", definition: "只说效果，没有人、场景或细节" },
  { id: "t2", name: "人群场景+痛点+效果", definition: "信息最完整的一类" },
  { id: "t3", name: "痛点+效果", definition: "有痛点有结果，缺人设和场景" },
  { id: "t4", name: "人群场景+效果", definition: "有代入感但痛点弱" },
  { id: "t5", name: "体验细节", definition: "质地气味泡沫等实物感描述为主" },
  { id: "t6", name: "未使用待观察", definition: "刚收到、还没用或用得太短" },
  { id: "t7", name: "泛化无信息", definition: "好用不错可以，零信息量" },
  { id: "t8", name: "服务物流", definition: "讲发货包装客服，与产品力无关" },
] as const;

export const TOPICS = [
  { id: "q1", name: "效果验证", definition: "询问是否有效、具体效果强弱或与替代品相比是否值得购买", includeWhen: "主要决策意图是验证去屑、止痒、控油等效果", excludeWhen: "主要询问使用周期、特定人群、安全性或规格" },
  { id: "q2", name: "适用人群与症状", definition: "询问特定人群、头皮状态或症状能否使用", includeWhen: "核心是孕妇、儿童、敏感头皮、染烫或具体症状是否适用", excludeWhen: "核心是成分、使用步骤或见效时间" },
  { id: "q3", name: "规格价格与活动", definition: "询问容量、价格、赠品、组合或促销规则", includeWhen: "核心是买多少、多少钱、包含什么或活动机制", excludeWhen: "核心是效果、成分或使用方法" },
  { id: "q4", name: "使用体验与安全顾虑", definition: "询问刺激、干涩、气味、副作用或使用后的不适", includeWhen: "核心是体验风险、安全顾虑或负面反应", excludeWhen: "只问某类人能否使用而没有具体体验风险" },
  { id: "q5", name: "无关或低信息提问", definition: "与购买决策无关或无法判断意图的问题", includeWhen: "文本是占位、灌水、无意义字符或明显无关", excludeWhen: "可以归入其他任一明确决策主题" },
  { id: "q6", name: "成分与配方", definition: "询问活性成分、浓度、完整成分表或配方属性", includeWhen: "核心是二硫化硒、硅油、中草药、浓度或具体成分", excludeWhen: "只问效果或安全结果而不问配方" },
  { id: "q7", name: "品牌与信任资质", definition: "询问正品、品牌、备案、证书或宣传可信度", includeWhen: "核心是来源、真伪、品牌背书、资质或检测证明", excludeWhen: "核心是物流售后或产品功效" },
  { id: "q8", name: "使用方法与见效周期", definition: "询问频次、步骤、组合顺序、用量或多久见效", includeWhen: "核心是怎么用、多久用一次、多久见效或维持多久", excludeWhen: "只问是否有效而不关心方法或时间" },
] as const;
