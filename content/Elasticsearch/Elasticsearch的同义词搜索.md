+++
date = '2026-03-17T21:32:33+08:00'
draft = false
title = 'Elasticsearch的同义词搜索'
+++

使用 ES 怎么能实现用相同意思的词或字搜索出相同的内容？这就是同义词问题。

ES 早期的同义词搜索是通过定义分词器的 `filter` 来实现的，示例如下：

```http
PUT /product_index
{
  "settings": {
    "analysis": {
      "filter": {
        "product_synonym_filter": {
          "type": "synonym",
          "synonyms": [
            "手机, 移动电话, cell phone",
            "苹果 => apple",
            "电脑, 计算机, pc"
          ]
        }
      },
      "analyzer": {
        "product_analyzer": {
          "tokenizer": "standard",
          "filter": [
            "lowercase",
            "product_synonym_filter"
          ]
        }
      }
    }
  },
  "mappings": {
    "properties": {
      "title": {
        "type": "text",
        "analyzer": "product_analyzer"
      }
    }
  }
}
```

`type: synonym` 代表该 `filter` 是同义词过滤器；`synonyms` 中定义的是同义词，像 `"手机, 移动电话, cell phone"` 这样以 `,` 分割的一组词代表他们是双向的，而以 `=>` 符号分割，代表只能由 `苹果` 推 `apple`，不能由 `apple` 推 `苹果`。

这样定于在分词器的做法问题很明显。将同义词写死在 mapping，修改同义词时等同于重建索引。

ES 8.x 新增了同义词 API，提供集中式同义词管理方案。同义词不再写死在 mapping 中，同义词会是一个独立资源，可动态更新，多索引复用。

下面这样就相当于创建了一个同义词集合：

```http
PUT /_synonyms/my-synonyms
{
  "synonyms_set": [
    {
      "id": "mobile",
      "synonyms": "手机, 移动电话, cell phone"
    },
    {
      "id": "fruit",
      "synonyms": "苹果, apple"
    }
  ]
}
```

`id` 只是一个标识符，用于管理、引用、更新这条同义词组。`synonyms` 中定义要设置的同义词，上面示例中的是双向的，如果要单向的需要使用 `=>`。

在 analyzer 中引用同义词集合

```json
"filter": {
  "my_synonym_filter": {
    "type": "synonym_graph",
    "synonyms_set": "my-synonyms"
  }
}
```

`synonyms_set` 是用来定义该 `filter` 使用的同义词集合的。

使用同义词集合后，当集合改变，mapping 结构不需要改变就可以生效

我们在之前的章节中学过可以分别为构建索引的字段和搜索的字段配置分词器。这样以分词器为核心实现的同义词功能就有两种策略：

- **索引时同义**，在写入文档时，把同义词展开。同义词被真正写入倒排索引。这样查询速度会比较快，查询时无额外分析成本。但是这样会导致索引膨胀，变更时必须 `reindex`
- **搜索时同义**，不在索引写入，而是查询时把 `query` 扩展成多个词。这样的好处是不需要重建索引，更复合搜索系统本质。但是查询可能稍慢 query DSL 更复杂。

ES 8.x 推荐在搜索时使用同义词，这样不影响索引，可动态维护同义词。

参考：

**https://cloud.tencent.com/developer/article/2336602**
