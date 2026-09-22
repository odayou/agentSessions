'use strict'
// 轮次目的启发式分类（L2 主题种子）：
// 仅保留本地需要的文本关键词 + 轮次归类；不引入缓存路径依赖，避免安装位置漂移。

const PURPOSE_KEYWORDS = [
  ['bug_fix', ['修复', '报错', '异常', '崩溃', '错误', 'error', 'fix ', 'failed']],
  ['debugging', ['为什么', '排查', '调试', '定位', '原因', 'debug', 'trace', '断点']],
  ['code_review', ['review', '评审', '检查代码', 'review 这个']],
  ['env_deploy', ['部署', 'deploy', '配置', '环境', '安装', '依赖', 'docker', 'ci']],
  ['testing', ['测试', '单测', '用例', 'test', 'jest', 'pytest', '跑一下']],
  ['code_refactor', ['重构', 'refactor', '优化', '整理', '拆分', '抽取']],
  ['code_generation', ['实现', '新增', '写一个', '写个', '开发', 'implement', 'create ', 'add ']],
  ['documentation', ['文档', 'readme', '注释', '说明', 'doc']],
  ['solution_design', ['设计', '方案', '架构', '选型', 'design']],
  ['learning_qa', ['解释', '区别', '原理', '是什么', '怎么用', 'how ', 'why ', '概念']],
  ['code_search', ['查找', '搜索', '在哪', '哪里', '用法', '找一下', 'search']],
  ['requirement_clarification', ['需求', '澄清', '明确', '背景', '拆解', '要求']],
]

const WRITE_TOOL_NAMES = ['edit', 'write', 'patch', 'applypatch', 'multiedit', 'notebookedit']

// 返回本轮的 purpose 枚举（作为主题/子主题种子）
function classifyPurpose(userText, toolNames) {
  const text = String(userText || '').toLowerCase()
  const tools = Array.isArray(toolNames) ? toolNames.map((t) => String(t).toLowerCase()) : []
  for (const [purpose, keywords] of PURPOSE_KEYWORDS) {
    for (const kw of keywords) {
      if (text.includes(kw)) return purpose
    }
  }
  if (tools.some((t) => WRITE_TOOL_NAMES.includes(t))) return 'code_refactor'
  if (tools.some((t) => /^(task|agent)/.test(t))) return 'code_generation'
  if (tools.some((t) => /(webfetch|websearch)/.test(t))) return 'learning_qa'
  if (tools.length > 0 && tools.every((t) => /(read|grep|glob|list|view)/.test(t))) return 'code_search'
  return 'other'
}

module.exports = { classifyPurpose }