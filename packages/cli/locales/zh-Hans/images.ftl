jouzu-cli-images-description = 在之后的请求中省略被提供方拒绝的图片
jouzu-cli-images-rejected = 提供方拒绝了此对话中的一张图片，之后的每个请求都会以同样方式失败。运行 { $command } 可在之后的请求中省略失败请求中的图片。会话仍保留这些图片。
jouzu-cli-images-omitted = { $count ->
   *[other] 之后的请求将省略 { $count } 张图片。
}
jouzu-cli-images-restored = 之后的请求将重新发送已省略的图片。
jouzu-cli-images-nothingRejected = 没有请求因图片被拒绝。
jouzu-cli-images-nothingOmitted = 当前没有省略的图片。
jouzu-cli-images-usage = 提供方拒绝图片后使用 { $omit }，或使用 { $restore } 重新发送已省略的图片。
