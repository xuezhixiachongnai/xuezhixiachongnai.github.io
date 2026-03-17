+++
date = '2026-03-17T21:35:47+08:00'
draft = false
title = 'Elasticsearch数据同步方案'

+++

在使用中，ES 不能代替 MySQL 这种关系型数据库，数据最终都以 MySQL 为主。ES 同步 MySQL 数据有哪些阶段呢？

1. 初始化阶段，全量同步。
2. 运行阶段，增量同步。

## 全量同步 MySQL

### 定时任务

最常见的方案是使用定时任务 + Bulk API 实现全量同步。

在同步时，建议将索引的 refresh 机制 关闭 `index.refresh_interval = -1` ，分页读取 MySQL 数据，并使用 Bulk API 写入 ES。等待同步完了之后打开 refresh，强制执行 refresh 一次。

> 为什么关闭 refresh，因为 refresh 会创建 Segment 并打开 Searcher，在大量写入时会严重影响吞吐量。

### Logstash JDBC

Logstash 是 Elastic Stack 中的一个通用数据采集与处理引擎，用于把各种来源的数据，如日志、数据库、消息队列。进行采集、解析、转换、输出到目标系统。最常见便是是 ES。

Logstash 的工作模型非常简单、也非常强大：

```markdown
[input] ──► [filter] ──► [output]
```

- Input：数据从哪里来
- Filter：对数据做什么
- Output：数据到哪里去

所有逻辑都通过配置文件（.conf）完成。

JDBC 插件是 Logstash 的 Input 插件之一：

```markdown
MySQL ──JDBC──► Logstash ──► Elasticsearch
```

它的特点是：

- 定时执行 SQL
- 记录上次同步进度（sql_last_value）
- 无需改业务代码

我们可以使用 Logstash 实现 MySQL 到 ES 的全量数据同步。

步骤：

安装 JDBC 插件。

然后配置 Logstash pipeline 配置。

```js
input {
  jdbc {
    jdbc_driver_library => "/opt/jdbc/mysql-connector-j-8.0.33.jar"
    jdbc_driver_class   => "com.mysql.cj.jdbc.Driver"
    jdbc_connection_string => "jdbc:mysql://localhost:3306/shop"
    jdbc_user => "root"
    jdbc_password => "123456"

    statement => "
      SELECT id, name, price, update_time
      FROM product
      WHERE update_time > :sql_last_value
    "

    schedule => "*/1 * * * *"   # 每分钟
    use_column_value => true
    tracking_column => "update_time"
    tracking_column_type => "timestamp"
  }
}

output {
  elasticsearch {
    hosts => ["http://localhost:9200"]
    index => "product_index"
    document_id => "%{id}"
  }
}
```

`statement` 是执行的 SQL，`WHERE update_time > :sql_last_value` 这是增量条件，`sql_last_value` 是 Logstash 内置的一个变量，表示上次同步到的值。`tracking_column` 指定用来做增量判断的字段，`document_id` 用 MySQL 主键作为 ES 文档 ID，可以保证写入的幂等性。

## 增量同步

### 同步双写

在写入 MySQL 时就串行写入 ES。此方案的好处是实时性好，实现简单。但是问题也很致命，MySQL 与 ES 事务无法统一，任何一方失败都会导致数据不一致，并且 ES 写入会拖慢业务链路。不推荐使用。

```java
@Transactional
public void updateProduct(Product product) {
    productMapper.update(product);
    esService.update(product);
}
```

### 异步双写

可以通过使用 MQ 解耦。

MySQL 事务提交成功后同步调用 MQ API 给 ES 端发送同步消息，消费端写入 ES。

```markdown
MySQL（事务提交）
   ↓
MQ（可靠投递）
   ↓
ES Consumer
```

它的优点便是解耦，可削峰，写入失败可重试。但是 MQ 要必须保证至少一次投递，ES 写入要保证幂等，允许短暂不一致。

MySQL 写入后发送 MQ 

```java
@Transactional
public void updateProduct(Product product) {
    productMapper.update(product);

    mqProducer.send("product-sync", product.getId());
}
```

消费端重新查 MySQL，覆盖写 ES。

```java
@MQListener(topic = "product-sync")
public void consume(Long productId) {
    Product product = productMapper.selectById(productId);
    if (product == null) return;

    esClient.index(new IndexRequest("product_index")
        .id(productId.toString())
        .source(convert(product)),
        RequestOptions.DEFAULT);
}
```

### Canal 监听 Binlog

Canal 监听 MySQL binlog，解析变更记录，同步 ES 算是比较主流的方案。对业务代码零侵入，完全基于数据库变更。

```markdown
MySQL
 ↓ binlog
Canal
 ↓
MQ（Kafka / RocketMQ）
 ↓
ES Sync Service
```

## 一致性问题

面试官不会满意上述的答案，老是追问线上出现数据不一致该怎能办，下面总结了常见的导致数据不一致的场景及其一些解决方案。

#### 写入失败

为了应对写入失败，我们要做好**重试机制**，重试的时间间隔是梯度上升的，要有最大重试次数。要做好写入失败的记录，方便人工或定时补偿。

```java
public void writeEsWithRetry(Product product) {
    int retry = 0;
    while (retry < 3) {
        try {
            esService.write(product);
            return;
        } catch (Exception e) {
            retry++;
            Thread.sleep(1 << retry * 1000L);
        }
    }
    failRepository.save(product.getId());
}
```

#### 写入覆盖

在大量并发写入的情景下，多个 binlog、MQ 消息到达顺序不可控，顺序混乱。很可能发生 ES 后写覆盖先写的问题。

常见的解决方案有：

- ES 的写入通知只是告诉那一条数据发生变化了，始终让 ES 读取 MySQL 的最新数据完成写入。

- 也可以显式的通过 ES `_seq_no` 和 `_primary_term` 做版本控制，拒绝旧数据覆盖新数据。

  ```java
  UpdateRequest request = new UpdateRequest("product_index", productId.toString())
      .doc(convert(product))
      .setIfSeqNo(seqNo)
      .setIfPrimaryTerm(primaryTerm);
  
  esClient.update(request, RequestOptions.DEFAULT);
  ```

- 使用 MySQL 的 `update_time` 作为版本号。

- 或者让同一个业务的数据按顺序存放在 MQ 的一个队列中，ES 顺序消费这些数据。

  ```java
  String shardingKey = String.valueOf(productId);
  mqProducer.send("product-sync", shardingKey, productId);
  ```

#### 消息丢失

消息在传播过程中可能发生丢失，需要一个定期对账 + 修复的方案。

我们可以设计一个定时任务，定期扫描 MySQL 最近 N 分钟的数据。对比 ES 是否存在。或者数据 version 是否一致。然后重新写入 ES 并记录修复日志。

```java
@Scheduled(cron = "0 */5 * * * ?")
public void reconcile() {
    List<Product> recent = productMapper.selectUpdatedInLastMinutes(5);
    for (Product product : recent) {
        if (!esService.exists(product.getId())) {
            esService.write(product);
        }
    }
}
```

或者基于 `version` 或 `update_time`

```java
if (!Objects.equals(mysql.getUpdateTime(), es.getUpdateTime())) {
    esService.write(mysql);
}
```

参考：

**https://zhuanlan.zhihu.com/p/1903016685830661076**

**https://juejin.cn/post/7458598002535415823**
