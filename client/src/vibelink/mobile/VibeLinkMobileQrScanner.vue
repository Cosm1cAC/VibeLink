<template>
  <div
    v-if="open"
    class="fixed inset-0 z-100 flex flex-col justify-between bg-transparent select-none"
    data-testid="mobile-qr-scanner-overlay">
    <!-- Top Safe-Area Header -->
    <header
      class="w-full box-border pt-[var(--safe-area-inset-top)] px-12px pb-12px bg-black/55 text-white flex items-center justify-between backdrop-blur-xs">
      <button
        type="button"
        class="flex items-center gap-4px bg-transparent border-0 p-6px text-white cursor-pointer"
        data-testid="qr-scanner-cancel-btn"
        aria-label="关闭扫码"
        @click="handleCancel">
        <svg class="w-22px h-22px"><use href="#fanhui" /></svg>
        <span class="text-14px">取消</span>
      </button>
      <div class="text-15.5px font-semibold">扫一扫配对</div>
      <div class="w-56px"></div>
    </header>

    <!-- Center Translucent Viewfinder -->
    <div class="flex-1 flex flex-col items-center justify-center px-24px pointer-events-none">
      <div
        class="relative w-232px h-232px rounded-18px border border-white/30 bg-transparent shadow-[0_0_0_9999px_rgba(0,0,0,0.45)] flex items-center justify-center">
        <span class="absolute -top-2px -left-2px w-26px h-26px border-t-3 border-l-3 border-[#13987f] rounded-tl-12px"></span>
        <span class="absolute -top-2px -right-2px w-26px h-26px border-t-3 border-r-3 border-[#13987f] rounded-tr-12px"></span>
        <span class="absolute -bottom-2px -left-2px w-26px h-26px border-b-3 border-l-3 border-[#13987f] rounded-bl-12px"></span>
        <span class="absolute -bottom-2px -right-2px w-26px h-26px border-b-3 border-r-3 border-[#13987f] rounded-br-12px"></span>
        <div class="w-85% h-2px bg-[#13987f]/85 rounded-full animate-pulse"></div>
      </div>

      <div class="mt-20px px-14px py-7px rounded-full bg-black/60 text-white/95 text-12.5px text-center max-w-86vw">
        {{ statusText }}
      </div>

      <div
        v-if="errorText"
        class="mt-10px px-14px py-8px rounded-10px bg-[#7f1d1d]/85 text-[#fecaca] text-12px text-center max-w-86vw pointer-events-auto"
        data-testid="qr-scanner-error">
        {{ errorText }}
      </div>
    </div>

    <!-- Bottom Fallback Actions -->
    <div
      class="w-full box-border px-20px pt-14px pb-[calc(22px+var(--safe-area-inset-bottom))] bg-black/60 flex items-center justify-center gap-12px backdrop-blur-xs">
      <n-button
        type="primary"
        color="#13987f"
        round
        class="flex-1 max-w-220px"
        data-testid="qr-scanner-paste-btn"
        @click="handleFallbackPaste">
        粘贴配对码
      </n-button>
      <n-button
        secondary
        round
        class="text-white!"
        @click="handleCancel">
        返回
      </n-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue'
import { listen } from '@tauri-apps/api/event'
import {
  cancel,
  checkPermissions,
  Format,
  requestPermissions,
  scan
} from '@tauri-apps/plugin-barcode-scanner'
import { setAndroidWebViewTransparent } from '../runtime'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  close: []
  scanned: [raw: string]
  fallbackPaste: []
}>()

const statusText = ref('请将电脑端「控制面设置」里的配对二维码放入框内')
const errorText = ref('')
let sessionActive = false
let unlistenAndroidBack: (() => void) | null = null

function restoreSurface() {
  sessionActive = false
  if (typeof document !== 'undefined') {
    document.documentElement.classList.remove('vl-qr-scanning')
  }
  setAndroidWebViewTransparent(false)
  if (unlistenAndroidBack) {
    unlistenAndroidBack()
    unlistenAndroidBack = null
  }
  void cancel().catch(() => {})
}

function handleCancel() {
  restoreSurface()
  emit('close')
}

function handleFallbackPaste() {
  restoreSurface()
  emit('fallbackPaste')
}

async function beginNativeScan() {
  sessionActive = true
  errorText.value = ''
  statusText.value = '正在唤醒相机，请对准电脑端配对二维码...'
  if (typeof document !== 'undefined') {
    document.documentElement.classList.add('vl-qr-scanning')
  }
  setAndroidWebViewTransparent(true)

  try {
    unlistenAndroidBack = await listen('tauri://android-back', () => {
      handleCancel()
    })
  } catch {
    // Non-Android / browser test environment
  }

  try {
    let perm = await checkPermissions()
    if (perm !== 'granted') {
      perm = await requestPermissions()
    }
    if (!sessionActive) return
    if (perm !== 'granted') {
      errorText.value = '未获得相机权限，请在系统设置开启或点击下方「粘贴配对码」。'
      statusText.value = '等待相机授权'
      return
    }

    statusText.value = '对准电脑端的「VibeLink 配对二维码」自动识别'
    const res = await scan({
      windowed: true,
      formats: [Format.QRCode]
    })
    if (!sessionActive) return

    const content =
      res && typeof res === 'object' && 'content' in res && typeof res.content === 'string'
        ? res.content.trim()
        : ''
    if (!content) {
      errorText.value = '未读取到二维码内容，可重试或点击下方「粘贴配对码」。'
      return
    }

    restoreSurface()
    emit('scanned', content)
  } catch (err) {
    if (!sessionActive) return
    const msg = err instanceof Error ? err.message : String(err)
    errorText.value = /permission/i.test(msg)
      ? '相机权限受限，请改用下方「粘贴配对码」完成配对。'
      : `相机扫码不可用（${msg}），请使用下方「粘贴配对码」。`
    statusText.value = '相机扫码暂停'
  }
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      void beginNativeScan()
    } else {
      restoreSurface()
    }
  },
  { immediate: true }
)

onUnmounted(() => {
  restoreSurface()
})
</script>
