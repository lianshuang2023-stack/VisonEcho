# 参与 VisionEcho

[English](CONTRIBUTING.md) | **简体中文**

## 问题反馈

请在本仓库提交问题，说明预期结果、实际结果、复现步骤以及操作系统和浏览器版本。附上可公开的最小测试素材；不要上传密钥、私人视频或完整本地工作区。

## 代码修改

1. 从当前 main 分支创建工作分支。
2. 保持修改聚焦，为行为变化补充合成素材或模拟服务测试。
3. 在提交说明中写明变化、验证结果和已知限制。
4. 已记录的行为发生变化时，同步更新中英文说明。

```bash
.venv/bin/python -m pytest local_backend -q
npm --prefix dashboard/frontend run build
npm --prefix dashboard/frontend run lint
npm --prefix dashboard/frontend test
```

Azure 调用应由明确操作触发。测试默认使用模拟服务；实时验证需使用自己的资源并确认用量。

## 协作

遵守[协作约定](CODE_OF_CONDUCT.zh-CN.md)。发现可能暴露数据或凭据的问题时，通过已有的私密协作渠道联系仓库维护者，不在公开问题中发布敏感内容。许可证见 [LICENSE](LICENSE)。
