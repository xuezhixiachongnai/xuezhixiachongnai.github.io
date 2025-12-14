+++
date = '2025-12-14T18:11:52+08:00'
draft = false
title = 'BitMap和BloomFilter'
+++

## BitMap

在讲 `BitMap` 之前，我们先来了解一下 Redis 的 `String` 数据结构。

```c
struct sdshdr {
    // buf数组中已使用字节的数量
    int len;
    // buf数组中未使用字节的数量
    int free;
    // 字节数组，用于保存字符串
    char buf[];
};
```

我们可以看到，Redis 的 String 数据类型本质上就是一个字节数组。String 类型的值不单单可以做字符串，它还可以做整数或者浮点数。当然，今天的主角 BitMap 的底层也是 String。

我们将 String 的这种底层结构称之为 **SDS（简单动态字符串）**。

SDS 被广泛应用在 Redis 的各个地方，包括：

- 作为字符串对象的底层实现。
- 作为 Redis 客户端和服务器通信时的输入输出缓存区。存储待发送的命令或者带返回的结果。
- 在给 AOF 文件追加命令时，会先把命令追加到 SDS中，然后再把 SDS 写入 AOF 文件。

BitMap 存储数据的最小单位是 bit。因此，和使用字节存储的传统数据结构相比它再处理大量二值状态数据时有极高的空间效率。Redis 中的 BitMap 数据结构基于 SDS 存储。它的相关方法就是通过操作其中的字节数组来实现的。

Redis 提供了 `SETBIT`、`GETBIT`、`BITCOUNT`、`BITOP`几个命令。其中 `BITOP` 可以对一个或多个 BitMap 进行位运算，并将结果保存到新的键中，支持 AND、OR、NOT、XOR 四种操作。这个命令的用法是将多个 BitMap 中相同偏移量的位值进行运算。

Java 也提供了 `BitMap` 类，但是底层是通过 `long` 数组实现的。这里简单看一个使用 `byte[]` 数组实现的 BitMap

```java
public class Bitmap {

    private byte[] bitmap;

    // 构造函数，初始化位图的大小
    public Bitmap(int size) {
        bitmap = new byte[size / 8 + 1];
    }

    // 设置某个位置为 1，表示存在
    public void add(int value) {
        int byteIndex = value / 8;
        int bitIndex = value % 8;
        bitmap[byteIndex] |= (1 << bitIndex); // 将该位设置为1
    }

    public boolean contains(int value) {
        int byteIndex = value / 8;
        int bitIndex = value % 8;
        return (bitmap[byteIndex] & (1 << bitIndex)) != 0;
    }

    public static void main(String[] args) {
        Bitmap bitmap = new Bitmap(1000); // 创建一个大小为1000的位图

        bitmap.add(10); // 将值10加入位图
        bitmap.add(200); // 将值200加入位图

        System.out.println(bitmap.contains(10)); // 输出 true
        System.out.println(bitmap.contains(200)); // 输出 true
        System.out.println(bitmap.contains(300)); // 输出 false
    }
}
```

由此可见，BitMap 能极大的节省内存空间，并且 BitMap 的位置映射都是精确匹配的，查询时可以快速响应。通过一些位运算可以很容易的操作多个 BitMap。

但是也正因它的数据结构特点，导致它仅适用于表示两种状态，即 0 和 1。对于需要表示更多状态的情况，Bitmap 就不适用了。**只有当数据比较密集时才有优势，如果我们只设置（20，30，888888888）三个偏移量的位值，则需要创建一个 99999999 长度的 BitMap ，但是实际上只存了3个数据，这时候就有很大的空间浪费，碰到这种问题的话，可以通过引入另一个 `Roaring BitMap` 来解决。**

> **Roaring Bitmap** 是一种 **高性能、可压缩的位图数据结构**，专门用来高效表示和操作**大量整数集合**。

它的应用场景有：

- 用户签到状态（连续签到天数）
- 用户的在线状态（统计活跃用户）
- 问卷答题

## BloomFilter

上文中介绍了 BitMap 数据结构，在阅读的过程中有没有发现 BitMap 只能操作整数索引。如果我们想要使用 BitMap 来作一个网站的黑名单，如何将网络 ip 映射到 BitMap 的上呢。

这是我们就可以使用哈希函数，使用哈希函数将 ip 字符串映射成 BitMap 中的下标。这就是**布隆过滤器**。

Redis 原生并没有提供布隆过滤器，但是可以使用 Redis 官方提供的 **RedisBloom 模块**。

使用以下命令将模块加载入原生 Redis

```bash
redis-server --loadmodule redisbloom.so
```

如果使用单一哈希函数做映射的话，可能会出现哈希碰撞的情况，导致误判。布隆过滤器对这个问题做了优化，它会使用多个不同的哈希函数将一个值映射到 BitMap 的多个位置上，在做判断的时候，也会用这一组哈希函数做映射，判断所有位置上是否都是 1。这样哈希碰撞的情况变得比较可控。

布隆过滤器提供了这几个命令：`BF.RESERVE`、`BF.INFO`、`BF.ADD`、`BF.MADD`、`BF.EXISTS` 和 `BF.MEXISTS`

布隆过滤器的空间占用也是极小，它本身不存储完整的数据，和 BitMap一样底层也是通过 bit 位来表示数据是否存在。

但是布隆过滤器存在误判的情况，即当一个元素实际上不在集合中时，有可能被判断为在集合中。这是因为多个元素可能通过哈希函数映射到相同的位置，导致误判。但是，当布隆过滤器判断一个元素不在集合中时，则是 100% 正确的。并且，一般情况下，不能直接从布隆过滤器中删除元素。这是因为一个位置可能被多个元素映射到，如果直接将该位置的值置为 0，可能会影响其他元素的判断。

应用场景：

- 解决 Redis 缓存穿透问题：秒杀商品详情通常会被缓存到 Redis 中。如果有大量恶意请求查询不存在的商品，通过布隆过滤器可以快速判断这些商品不存在，从而避免了对数据库的查询，减轻了数据库的压力。
- 邮箱黑名单过滤：在邮件系统中，可以使用布隆过滤器来过滤垃圾邮件和恶意邮件。将已知的垃圾邮件发送者的地址或特征存储在布隆过滤器中，新邮件来时判断发送者是否在黑名单中。
- 对爬虫网址进行过滤：在爬虫程序中，为了避免重复抓取相同的网址，可以使用布隆过滤器来记录已经抓取过的网址。新网址出现时，先判断是否已抓取过。

Java 原生没有提供布隆过滤器，但是我们可以使用 BitMap 来自己实现一个简易的布隆过滤器，来看一下大致原理：

```java
public class BloomFilter {

    private BitSet bitSet;
    private int size; // 数组位的大小
    private int hashCount; // 哈希函数的个数

    public BloomFilter(int size, int hashCount) {
        this.size = size;
        this.hashCount = hashCount;
        bitSet = new BitSet(size);
    }

    //使用不同的hash函数对元素进行映射
    private int hash(String value, int i) {
        int hash = value.hashCode() + i;
        return Math.abs(hash % size);
    }

    public void add(String value) {
        for (int i = 0; i < hashCount; i++) {
            int hashValue = hash(value, i);
            bitSet.set(hashValue);
        }
    }

    public boolean contains(String value) {
        for (int i = 0; i < hashCount; i++) {
            int hashValue = hash(value, i);
            if (!bitSet.get(hashValue)) {
                return false;
            }
        }
        return true;
    }

    public static void main(String[] args) {
        BloomFilter bloomFilter = new BloomFilter(1000, 5); // 位数组大小1000，使用5个哈希函数

        bloomFilter.add("apple");
        bloomFilter.add("banana");
        bloomFilter.add("cherry");

        System.out.println(bloomFilter.contains("apple"));  // 输出 true
        System.out.println(bloomFilter.contains("banana")); // 输出 true
        System.out.println(bloomFilter.contains("grape"));  // 输出 false（有可能误判）
    }
}
```

参考：

https://www.cnblogs.com/chengxy-nds/p/18488414

https://cloud.tencent.com/developer/article/2343210
