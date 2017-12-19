# publish-to-qiniu

## 功能

1. 根据配置上传资源到七牛

2. 只上传新增或变更的资源

3. 上传后，刷新cdn缓存

## 使用方式

1. `npm install -g publish-to-qiniu`

2. 在项目的`package.json`中配置上传相关信息

3. 在项目根目录运行`publish-to-qiniu`

## 配置示例

```
  {
    "publishToQiniu": {
      "accessKey": "YOUR_ACCESS_KEY",
      "secretKey": "YOUR_SECRECT_KEY",
      "bucket": "BUCKET",
      "hosts": ["https://need-refresh.com"],
      "tasks": [
        {
          "from": "src",
          "to": "dist"
        }
      ]
    }
  }
```