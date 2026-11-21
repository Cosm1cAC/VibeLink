<template>
  <div class="flex flex-col h-full bg-[#141718] text-[#e5e7eb]" data-testid="bot-terminal-pane">
    <div class="flex items-center justify-between gap-2 px-3 py-2 bg-[#1c2021] border-b border-[#2c3335] text-12px">
      <div class="flex items-center gap-2 min-w-0">
        <span
          class="inline-block w-2 h-2 rounded-full shrink-0"
          :class="wsConnected ? 'bg-[#22c55e]' : 'bg-[#f59e0b]'"></span>
        <span class="font-medium text-[#d1fae5] truncate">
          PTY 终端 {{ activeSession ? `(${activeSession.sessionId})` : '' }}
        </span>
        <span v-if="activeSession?.cwd" class="text-[#8a9499] font-mono text-11px truncate max-w-260px">
          {{ activeSession.cwd }}
        </span>
      </div>

      <div class="flex items-center gap-1.5 shrink-0">
        <select
          v-if="roomSessions.length > 1"
          :value="activeSessionId ?? ''"
          class="bg-[#252b2c] border border-[#384042] rounded px-2 py-1 text-11px text-[#e5e7eb] outline-none"
          @change="selectSession(($event.target as HTMLSelectElement).value)">
          <option v-for="s in roomSessions" :key="s.sessionId" :value="s.sessionId">
            {{ s.sessionId }}
          </option>
        </select>

        <button
          type="button"
          class="px-2.5 py-1 rounded bg-[#262d2f] hover:bg-[#313a3c] border border-[#384042] text-[#e5e7eb] text-11.5px cursor-pointer"
          @click="handleNewTerminal">
          新建终端
        </button>
        <button
          type="button"
          class="px-2.5 py-1 rounded bg-[#262d2f] hover:bg-[#313a3c] border border-[#384042] text-[#e5e7eb] text-11.5px cursor-pointer"
          @click="handleClear">
          清屏
        </button>
        <button
          v-if="activeSessionId"
          type="button"
          class="px-2.5 py-1 rounded bg-[#3b1d1d] hover:bg-[#522626] border border-[#5f2f2f] text-[#fecaca] text-11.5px cursor-pointer"
          @click="handleCloseTerminal">
          关闭
        </button>
      </div>
    </div>

    <div v-if="errorMsg" class="px-3 py-1.5 bg-[#3b1d1d] text-[#fecaca] text-12px border-b border-[#5f2f2f]">
      {{ errorMsg }}
    </div>

    <div ref="containerRef" class="flex-1 min-h-0 p-2 overflow-hidden"></div>
  </div>
</template>

<script setup lang="ts">
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useVibeLinkStore } from '../store'

const props = defineProps<{
  roomId: string | null
  botId?: string | null
}>()

const store = useVibeLinkStore()
const containerRef = ref<HTMLElement | null>(null)
const activeSessionId = ref<string | null>(null)
const wsConnected = ref(false)
const errorMsg = ref<string | null>(null)

let term: Terminal | null = null
let fitAddon: FitAddon | null = null
let resizeObserver: ResizeObserver | null = null
let terminalConn: ReturnType<typeof store.client.connectTerminal> | null = null

const roomSessions = computed(() => {
  if (!props.roomId) return []
  return store.terminalsByRoom[props.roomId] ?? []
})

const activeSession = computed(() => {
  return roomSessions.value.find((s) => s.sessionId === activeSessionId.value) ?? null
})

function initXterm() {
  if (term || !containerRef.value) return
  term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    lineHeight: 1.25,
    fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
    theme: {
      background: '#141718',
      foreground: '#e5e7eb',
      cursor: '#13987f',
      selectionBackground: 'rgba(19, 152, 127, 0.35)'
    }
  })
  fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(containerRef.value)
  fitAddon.fit()

  term.onData((data) => {
    terminalConn?.sendInput(data)
  })

  resizeObserver = new ResizeObserver(() => {
    if (!fitAddon || !term) return
    fitAddon.fit()
    if (wsConnected.value) {
      terminalConn?.resize(term.cols, term.rows)
    }
  })
  resizeObserver.observe(containerRef.value)
}

function detachSocket() {
  if (terminalConn) {
    terminalConn.close()
    terminalConn = null
  }
  wsConnected.value = false
}

function attachSocket(sessionId: string) {
  detachSocket()
  errorMsg.value = null
  activeSessionId.value = sessionId
  if (!term) initXterm()
  term?.clear()

  terminalConn = store.client.connectTerminal(sessionId, {
    onStateChange: (up) => {
      wsConnected.value = up
      if (up && fitAddon && term) {
        fitAddon.fit()
        terminalConn?.resize(term.cols, term.rows)
      }
    },
    onSnapshot: (snap) => {
      if (snap?.snapshot && term) {
        term.reset()
        term.write(snap.snapshot)
      }
    },
    onOutput: (data) => {
      term?.write(data)
    },
    onCleared: () => {
      term?.clear()
    },
    onClosed: () => {
      wsConnected.value = false
      term?.writeln('\r\n[PTY 会话已关闭]')
    },
    onExited: () => {
      term?.writeln('\r\n[进程已退出]')
    },
    onError: (err) => {
      errorMsg.value = err
    }
  })
}

async function ensureAndAttach() {
  if (!props.roomId) return
  try {
    errorMsg.value = null
    const session = await store.ensureRoomTerminal(props.roomId, props.botId ?? null)
    await nextTick()
    attachSocket(session.sessionId)
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  }
}

function selectSession(sessionId: string) {
  if (sessionId && sessionId !== activeSessionId.value) {
    attachSocket(sessionId)
  }
}

async function handleNewTerminal() {
  if (!props.roomId) return
  try {
    const session = await store.openNewRoomTerminal(props.roomId, props.botId ?? null)
    attachSocket(session.sessionId)
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  }
}

function handleClear() {
  term?.clear()
  terminalConn?.clear()
}

async function handleCloseTerminal() {
  const sid = activeSessionId.value
  if (!sid) return
  detachSocket()
  await store.closeTerminal(props.roomId, sid)
  activeSessionId.value = null
  const remaining = roomSessions.value
  if (remaining.length > 0) {
    attachSocket(remaining[0].sessionId)
  }
}

onMounted(() => {
  initXterm()
  void ensureAndAttach()
})

watch(
  () => props.roomId,
  () => {
    activeSessionId.value = null
    void ensureAndAttach()
  }
)

onUnmounted(() => {
  detachSocket()
  resizeObserver?.disconnect()
  resizeObserver = null
  term?.dispose()
  term = null
})
</script>
