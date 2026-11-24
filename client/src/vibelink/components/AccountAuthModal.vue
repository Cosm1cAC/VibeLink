<template>
  <div
    v-if="open"
    class="fixed inset-0 z-70 flex items-center justify-center bg-black/72 backdrop-blur-xs p-3"
    data-testid="account-auth-modal"
    @click.self="dismissible ? $emit('close') : undefined">
    <div class="w-full max-w-440px rounded-14px bg-[#1f2222] border border-[#353a39] text-[#eaeaea] shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
      <div class="flex items-center justify-between px-4 py-3 bg-[#242828] border-b border-[#343938]">
        <div>
          <div class="text-15px font-semibold text-white">VibeLink 账号与福利中心</div>
          <div class="text-11px text-[#9ca3af]">
            支持邀请码注册、免费 Token 领取与主备服务器自动切换
          </div>
        </div>
        <button
          v-if="dismissible"
          type="button"
          class="px-2.5 py-1 rounded bg-[#2d3232] border-0 text-[#ccc] cursor-pointer text-12px"
          @click="$emit('close')">
          关闭
        </button>
      </div>

      <div class="p-4 space-y-3 overflow-y-auto">
        <!-- Server selector -->
        <div class="space-y-1.5 text-12px">
          <div class="flex items-center justify-between">
            <span class="text-[#9ca3af]">连接服务器（支持主服 / Mac mini 备服 / 公网域名）</span>
            <span v-if="store.clusterSummary" class="text-10.5px px-1.5 py-0.5 rounded bg-[#143d2d] text-[#4ade80]">
              {{ store.clusterSummary.nodeLabel }}
            </span>
          </div>
          <input
            v-model="targetServerUrl"
            type="text"
            placeholder="http://127.0.0.1:18990 或 https://your-domain.com"
            class="w-full box-border px-3 py-2 rounded-7px bg-[#141616] border border-[#383d3c] text-[#eaeaea] font-mono text-12px outline-none focus:border-[#13987f]" />
          <div v-if="store.channels.length > 0" class="flex flex-wrap gap-1.5">
            <button
              v-for="ch in store.channels"
              :key="ch.id"
              type="button"
              class="px-2 py-0.5 rounded-full border text-10.5px cursor-pointer"
              :class="
                targetServerUrl.trim().replace(/\/+$/, '') === ch.url
                  ? 'bg-[#13987f]/25 border-[#13987f] text-[#5eead4]'
                  : 'bg-[#181b1b] border-[#333938] text-[#9ca3af] hover:text-white'
              "
              @click="targetServerUrl = ch.url">
              {{ ch.label }}
            </button>
          </div>
        </div>

        <!-- Mode tabs -->
        <div class="flex gap-1.5 p-1 rounded-8px bg-[#151818] border border-[#2d3231] text-12.5px">
          <button
            type="button"
            data-testid="auth-tab-login"
            class="flex-1 py-1.5 rounded-6px border-0 cursor-pointer font-medium"
            :class="mode === 'login' ? 'bg-[#13987f] text-white' : 'bg-transparent text-[#9ca3af]'"
            @click="mode = 'login'">
            账号登录
          </button>
          <button
            type="button"
            data-testid="auth-tab-register"
            class="flex-1 py-1.5 rounded-6px border-0 cursor-pointer font-medium"
            :class="mode === 'register' ? 'bg-[#13987f] text-white' : 'bg-transparent text-[#9ca3af]'"
            @click="mode = 'register'">
            邀请码注册
          </button>
        </div>

        <form v-if="mode === 'login'" class="space-y-2.5 text-12px" @submit.prevent="submitLogin">
          <label class="block space-y-1">
            <span class="text-[#9ca3af]">用户名</span>
            <input
              v-model="loginUsername"
              type="text"
              autocomplete="username"
              placeholder="输入用户名（默认主管理员为 admin）"
              class="vl-auth-input" />
          </label>
          <label class="block space-y-1">
            <span class="text-[#9ca3af]">密码</span>
            <input
              v-model="loginPassword"
              type="password"
              autocomplete="current-password"
              placeholder="输入账号密码"
              class="vl-auth-input" />
          </label>
          <button
            type="submit"
            data-testid="auth-login-submit"
            :disabled="submitting || !loginUsername.trim() || !loginPassword"
            class="w-full py-2 rounded-8px bg-[#13987f] hover:bg-[#17ad91] disabled:opacity-50 border-0 text-white font-medium text-13px cursor-pointer">
            {{ submitting ? '登录中...' : '立即登录' }}
          </button>
        </form>

        <form v-else class="space-y-2.5 text-12px" @submit.prevent="submitRegister">
          <label class="block space-y-1">
            <span class="text-[#9ca3af]">邀请码（向管理员获取）</span>
            <input
              v-model="regInviteCode"
              type="text"
              placeholder="例如：VL-XXXXXXXX"
              class="vl-auth-input font-mono uppercase" />
          </label>
          <div class="grid grid-cols-2 gap-2">
            <label class="block space-y-1">
              <span class="text-[#9ca3af]">用户名（字母数字）</span>
              <input
                v-model="regUsername"
                type="text"
                autocomplete="username"
                placeholder="例如：alice"
                class="vl-auth-input" />
            </label>
            <label class="block space-y-1">
              <span class="text-[#9ca3af]">显示昵称</span>
              <input
                v-model="regDisplayName"
                type="text"
                placeholder="可选，默认同用户名"
                class="vl-auth-input" />
            </label>
          </div>
          <label class="block space-y-1">
            <span class="text-[#9ca3af]">设置密码（至少 6 位）</span>
            <input
              v-model="regPassword"
              type="password"
              autocomplete="new-password"
              placeholder="输入至少 6 位密码"
              class="vl-auth-input" />
          </label>
          <button
            type="submit"
            data-testid="auth-register-submit"
            :disabled="submitting || !regUsername.trim() || regPassword.length < 6 || !regInviteCode.trim()"
            class="w-full py-2 rounded-8px bg-[#13987f] hover:bg-[#17ad91] disabled:opacity-50 border-0 text-white font-medium text-13px cursor-pointer">
            {{ submitting ? '注册中...' : '使用邀请码注册并领取初始额度' }}
          </button>
        </form>

        <div
          v-if="infoMsg"
          class="px-3 py-2 rounded-7px bg-[#143d2d] border border-[#22c55e]/35 text-[#a7f3d0] text-12px">
          {{ infoMsg }}
        </div>
        <div
          v-if="errorMsg"
          class="px-3 py-2 rounded-7px bg-[#3b1d1d] border border-[#5f2f2f] text-[#fecaca] text-12px">
          {{ errorMsg }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { isMobileRuntime, normalizeServerUrl, setServerConfig } from '../runtime'
import { useVibeLinkStore } from '../store'

const props = withDefaults(
  defineProps<{
    open: boolean
    dismissible?: boolean
  }>(),
  {
    dismissible: true
  }
)

const emit = defineEmits<{
  close: []
}>()

const store = useVibeLinkStore()
const mode = ref<'login' | 'register'>('login')
const targetServerUrl = ref(store.serverUrl)
const loginUsername = ref('')
const loginPassword = ref('')
const regInviteCode = ref('')
const regUsername = ref('')
const regDisplayName = ref('')
const regPassword = ref('')
const submitting = ref(false)
const errorMsg = ref('')
const infoMsg = ref('')

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      targetServerUrl.value = store.serverUrl
      errorMsg.value = ''
      infoMsg.value = ''
    }
  }
)

function applyTargetUrlBeforeAuth() {
  const normalized = normalizeServerUrl(targetServerUrl.value)
  if (normalized !== store.serverUrl) {
    setServerConfig(normalized, store.authToken)
    store.serverUrl = normalized
    store.client.configure(normalized, store.authToken, store.sessionToken)
  }
}

async function submitLogin() {
  errorMsg.value = ''
  infoMsg.value = ''
  submitting.value = true
  try {
    applyTargetUrlBeforeAuth()
    const deviceLabel = isMobileRuntime() ? 'Mobile App' : 'Desktop Client'
    await store.authLogin(loginUsername.value.trim(), loginPassword.value, deviceLabel)
    loginPassword.value = ''
    emit('close')
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    submitting.value = false
  }
}

async function submitRegister() {
  errorMsg.value = ''
  infoMsg.value = ''
  submitting.value = true
  try {
    applyTargetUrlBeforeAuth()
    const deviceLabel = isMobileRuntime() ? 'Mobile App' : 'Desktop Client'
    const res = await store.authRegister({
      username: regUsername.value.trim(),
      password: regPassword.value,
      ...(regDisplayName.value.trim() ? { displayName: regDisplayName.value.trim() } : {}),
      inviteCode: regInviteCode.value.trim(),
      deviceLabel
    })
    infoMsg.value =
      res.welcomeTokens > 0
        ? `注册成功！已获赠 ${res.welcomeTokens.toLocaleString()} Tokens`
        : '注册成功！'
    regPassword.value = ''
    emit('close')
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.vl-auth-input {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border-radius: 7px;
  background: #141616;
  border: 1px solid #383d3c;
  color: #eaeaea;
  font-size: 12.5px;
  outline: none;
}

.vl-auth-input:focus {
  border-color: #13987f;
}
</style>
