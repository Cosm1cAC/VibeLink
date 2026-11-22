<template>
  <span
    class="inline-flex items-center justify-center shrink-0 overflow-hidden select-none font-semibold"
    :class="shape === 'rounded' ? 'rounded-9px' : 'rounded-full'"
    :style="wrapperStyle">
    <img
      v-if="imgSrc && !imgFailed"
      :src="imgSrc"
      :alt="name || 'avatar'"
      class="w-full h-full object-cover block"
      @error="imgFailed = true" />
    <span v-else class="leading-none">{{ fallbackSpec.label }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { resolveAvatarImageSrc, resolveAvatarSpec } from '../avatar'
import { useVibeLinkStore } from '../store'

const props = withDefaults(
  defineProps<{
    avatar?: string | null
    name?: string | null
    provider?: string | null
    size?: number
    shape?: 'circle' | 'rounded'
  }>(),
  {
    avatar: '',
    name: '',
    provider: '',
    size: 36,
    shape: 'circle'
  }
)

const store = useVibeLinkStore()
const imgFailed = ref(false)

watch(
  () => props.avatar,
  () => {
    imgFailed.value = false
  }
)

const imgSrc = computed(() =>
  resolveAvatarImageSrc(props.avatar, store.serverUrl, store.authToken)
)

const fallbackSpec = computed(() =>
  resolveAvatarSpec(props.avatar, props.name, props.provider)
)

const wrapperStyle = computed(() => {
  const px = `${props.size}px`
  const fontSize = `${Math.max(10, Math.round(props.size * 0.34))}px`
  return {
    width: px,
    height: px,
    fontSize,
    background: imgSrc.value && !imgFailed.value ? '#222' : fallbackSpec.value.bg,
    color: fallbackSpec.value.fg
  }
})
</script>
