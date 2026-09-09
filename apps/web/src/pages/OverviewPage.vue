<script setup lang="ts">
const milestones = ['连接 Mac', '启动会话', '镜像终端', '处理审批'];
</script>

<template>
  <main>
    <p class="eyebrow">M0 · PROJECT BOOTSTRAP</p>
    <h1>终端中继控制台</h1>
    <p>服务端和协议骨架已经就绪。完成阶段 0 探针后，这里将显示真实设备与会话。</p>
    <section class="grid">
      <article v-for="(milestone, index) in milestones" :key="milestone">
        <span>0{{ index + 1 }}</span>
        <h2>{{ milestone }}</h2>
        <small>等待实现</small>
      </article>
    </section>
  </main>
</template>

