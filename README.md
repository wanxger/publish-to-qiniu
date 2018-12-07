# publish-to-qiniu

## 功能

1. 根据配置上传资源到七牛

2. 只上传新增或变更的资源

3. 上传后，刷新发生了变更的资源的cdn缓存

## 使用方式

1. `npm install -g publish-to-qiniu`

2. 在项目根目录下的`package.json`中配置上传相关信息

3. 在项目根目录下运行`publish-to-qiniu`

## 参数

1. `--no-refresh` 跳过刷新cdn缓存的步骤

## 配置示例

### 单bucket
```
  {
    "publishToQiniu": {
      "accessKey": "YOUR_ACCESS_KEY",
      "secretKey": "YOUR_SECRECT_KEY",
      "bucket": "YOUR_BUCKET",
      // 假设有一个变更了的资源 src/a.json
      // 那么上传后将请求七牛对 https://need-refresh.com/dist/a.json 进行刷新
      "hosts": ["https://need-refresh.com"],
      "tasks": [
        // PROJECT/src/**/* -> YOUR_BUCKET/dist/**/*
        {
          "from": "src",
          // 如果需直接上传至bucket的根目录，则值设为""
          "to": "dist"
        }
      ]
    }
  }
```

### 多bucket
```
  {
    "publishToQiniu": [
      {
        "accessKey": "YOUR_ACCESS_KEY",
        "secretKey": "YOUR_SECRECT_KEY",
        "bucket": "YOUR_BUCKET_1",
        "hosts": ["https://need-refresh-1.com"],
        "tasks": [
          {
            "from": "src/1",
            "to": "dist"
          }
        ]
      },
      {
        "accessKey": "YOUR_ACCESS_KEY",
        "secretKey": "YOUR_SECRECT_KEY",
        "bucket": "YOUR_BUCKET_2",
        "hosts": ["https://need-refresh-2.com"],
        "tasks": [
          {
            "from": "src/2",
            "to": "dist"
          }
        ]
      }
    ]
  }
```