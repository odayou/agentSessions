'use strict'
// Lingma（通义灵码）占位适配器：已探测安装（~/.lingma）。
// 会话索引为私有二进制格式（index/chat/v4/<project>/store/*.zap + bolt），暂不支持内容级索引；
// 待格式明确后在此实现 sources/parseFile 即可无缝接入扫描链路。
module.exports = { id: 'lingma', label: 'Lingma', placeholder: true }
