export function buildMemoryContext(memories) {
  if (!Array.isArray(memories) || memories.length === 0) return "";
  const lines = memories.map((memory, index) => `${index + 1}. ${memory.text}`);
  return `以下是和当前用户有关的长期记忆，仅在相关时自然使用，不要生硬复述，不要逐条照搬：\n${lines.join("\n")}`;
}

export function buildMemoryExtractionMessages(userText, assistantText) {
  return [
    {
      role: "system",
      content:
        "你是一个记忆提炼器。请从对话中提炼适合长期保存的用户信息，只保留稳定偏好、身份信息、长期项目、明确要求、重要关系、长期目标。不要保存一次性闲聊、临时问题、礼貌用语。只返回 JSON，不要解释。JSON 格式：{\"memories\":[{\"text\":\"...\",\"category\":\"preference|profile|project|goal|relationship|instruction|general\",\"tags\":[\"...\"],\"importance\":1-5,\"pinned\":true|false}]}。",
    },
    {
      role: "user",
      content: `用户消息：${userText}\n助手回复：${assistantText}\n请提炼值得长期记忆的信息；如果没有，返回 {"memories":[]}。`,
    },
  ];
}
