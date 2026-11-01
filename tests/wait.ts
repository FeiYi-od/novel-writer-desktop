// 测试等待上限：只约束"最终完成"，不是行为断言。全量运行时机器负载高，
// 固定的 5–10 秒会误报；统一读环境变量，断言本身不变。
export const WAIT_LIMIT = Number(process.env.NOVEL_TEST_WAIT_MS ?? 180000);
