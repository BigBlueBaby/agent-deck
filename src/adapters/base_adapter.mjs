/** 执行器契约。实现负责探测、构造提示、运行 worker 和归一化事件。 */
export class BaseAdapter {
  constructor(id, name) {
    this.id = id;
    this.name = name;
  }

  async detect(_config) {
    throw new Error("执行器尚未实现探测");
  }

  buildPrompt(_task, _brief, _isResume, _guardrailsConfig) {
    throw new Error("执行器尚未实现提示组装");
  }

  async run(_task, _brief, _isResume, _callbacks) {
    throw new Error("执行器尚未实现任务运行");
  }

  parseEvent(_event) {
    throw new Error("执行器尚未实现事件转换");
  }
}
