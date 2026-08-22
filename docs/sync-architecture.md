# Mail Collector 多端同步模型

## 目标

Mail Collector 采用类似现代输入法/知识库应用的同步思路：

- VPS 保存权威状态。
- 每个客户端保存本地缓存。
- 客户端通过增量 revision 同步，而不是全量刷新。

## 数据流

```
              VPS Core

    revision counter
    operation log
    device registry

          HTTPS Sync API

      /                 \
 Windows               Android
 local cache            local cache
```

## Revision

每次影响用户状态的操作生成 revision：

```
1001 read message
1002 add star
1003 move to archive
```

客户端保存：

```
last_sync_revision
```

下一次只请求：

```
revision > last_sync_revision
```

## Operation Log

不要直接覆盖数据：

```
DELETE message
```

改为：

```
operation:
{
 type: trash,
 messageId: xxx,
 deviceId: android
}
```

服务器执行并广播给其他设备。

## 冲突处理

默认规则：

1. VPS revision 优先。
2. 同一对象使用服务器时间排序。
3. 删除操作进入回收状态，不立即物理删除。
4. 客户端离线期间产生的操作进入本地 outbox。

## 设备

每个安装实例拥有：

- device_id
- platform
- last_seen
- last_sync_revision

支持：

- 查看登录设备
- 撤销设备
- 多端同时在线
