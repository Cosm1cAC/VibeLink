import {
  createRouter,
  createWebHistory,
  type NavigationGuardNext,
  type RouteLocationNormalized,
  type RouteRecordRaw
} from 'vue-router'
import { isMobileRuntime } from '@/vibelink/runtime'

import FriendsList from '@/views/homeWindow/FriendsList.vue'
import Message from '@/views/homeWindow/message/index.vue'
import SearchDetails from '@/views/homeWindow/SearchDetails.vue'

import ChatRoomLayout from '#/layout/chat-room/ChatRoomLayout.vue'
import NoticeLayout from '#/layout/chat-room/NoticeLayout.vue'
import FriendsLayout from '#/layout/friends/FriendsLayout.vue'
import GroupChatMember from '#/views/chat-room/GroupChatMember.vue'
import MobileInviteGroupMember from '#/views/chat-room/MobileInviteGroupMember.vue'
import MyLayout from '#/layout/my/MyLayout.vue'
import ChatSetting from '#/views/chat-room/ChatSetting.vue'
import MobileChatMain from '#/views/chat-room/MobileChatMain.vue'
import SearchChatContent from '#/views/chat-room/SearchChatContent.vue'
import MediaViewer from '#/views/chat-room/MediaViewer.vue'
import NoticeDetail from '#/views/chat-room/notice/NoticeDetail.vue'
import NoticeEdit from '#/views/chat-room/notice/NoticeEdit.vue'
import NoticeList from '#/views/chat-room/notice/NoticeList.vue'
import DynamicDetailPage from '#/views/community/DynamicDetailPage.vue'
import AddFriends from '#/views/friends/AddFriends.vue'
import ConfirmAddFriend from '#/views/friends/ConfirmAddFriend.vue'
import ConfirmAddGroup from '#/views/friends/ConfirmAddGroup.vue'
import FriendInfo from '#/views/friends/FriendInfo.vue'
import StartGroupChat from '#/views/friends/StartGroupChat.vue'
import EditBio from '#/views/my/EditBio.vue'
import EditBirthday from '#/views/my/EditBirthday.vue'
import EditProfile from '#/views/my/EditProfile.vue'
import MobileQRCode from '#/views/my/MobileQRCode.vue'
import MobileSettings from '#/views/my/MobileSettings.vue'
import MyMessages from '#/views/my/MyMessages.vue'
import PublishCommunity from '#/views/my/PublishCommunity.vue'
import Share from '#/views/my/Share.vue'
import SimpleBio from '#/views/my/SimpleBio.vue'
import AiAssistant from '#/views/my/AiAssistant.vue'
import MyAlbum from '#/views/my/MyAlbum.vue'
import ConfirmQRLogin from '#/views/ConfirmQRLogin.vue'
import MyQRCode from '#/views/MyQRCode.vue'
import Splashscreen from '#/views/Splashscreen.vue'
import MobileForgetPassword from '#/views/MobileForgetPassword.vue'
import MobileServiceAgreement from '#/views/MobileServiceAgreement.vue'
import MobilePrivacyAgreement from '#/views/MobilePrivacyAgreement.vue'
import SyncData from '#/views/SyncData.vue'

/**! 创建窗口后再跳转页面就会导致样式没有生效所以不能使用懒加载路由的方式，有些页面需要快速响应的就不需要懒加载 */
const { BASE_URL } = import.meta.env

const VibeLinkDesktopShell = () => import('@/vibelink/components/VibeLinkDesktopShell.vue')
const VibeLinkMobileShell = () => import('@/vibelink/mobile/VibeLinkMobileShell.vue')

const isMobile = isMobileRuntime()

// 移动端路由配置 - 共享 VibeLink Mobile Shell
const getMobileRoutes = (): Array<RouteRecordRaw> => [
  {
    path: '/mobile/MobileForgetPassword',
    name: 'mobileForgetPassword',
    component: MobileForgetPassword
  },
  {
    path: '/mobile/serviceAgreement',
    name: 'mobileServiceAgreement',
    component: MobileServiceAgreement
  },
  {
    path: '/mobile/privacyAgreement',
    name: 'mobilePrivacyAgreement',
    component: MobilePrivacyAgreement
  },
  {
    path: '/mobile/syncData',
    name: 'mobileSyncData',
    component: SyncData
  },
  {
    path: '/mobile/chatRoom',
    name: 'mobileChatRoom',
    component: ChatRoomLayout,
    children: [
      {
        path: '',
        name: 'mobileChatRoomDefault',
        redirect: '/mobile/chatRoom/chatMain'
      },
      {
        path: 'chatMain/:uid?', // 可选传入，如果传入uid就表示房间属于好友的私聊房间
        name: 'mobileChatMain',
        component: MobileChatMain,
        props: true,
        meta: { keepAlive: true }
      },
      {
        path: 'setting',
        name: 'mobileChatSetting',
        component: ChatSetting
      },
      {
        path: 'searchContent',
        name: 'mobileSearchChatContent',
        component: SearchChatContent
      },
      {
        path: 'mediaViewer',
        name: 'mobileMediaViewer',
        component: MediaViewer
      },
      {
        path: 'groupChatMember',
        name: 'mobileGroupChatMember',
        component: GroupChatMember,
        meta: { keepAlive: true }
      },
      {
        path: 'inviteGroupMember',
        name: 'mobileInviteGroupMember',
        component: MobileInviteGroupMember
      },
      {
        path: 'notice',
        name: 'mobileChatNotice',
        component: NoticeLayout,
        children: [
          {
            path: '',
            name: 'mobileChatNoticeList',
            component: NoticeList
          },
          {
            path: 'add',
            name: 'mobileChatNoticeAdd',
            component: NoticeEdit
          },
          {
            path: 'edit/:id',
            name: 'mobileChatNoticeEdit',
            component: NoticeEdit
          },
          {
            path: 'detail/:id',
            name: 'mobileChatNoticeDetail',
            component: NoticeDetail
          }
        ]
      }
    ]
  },
  {
    path: '/mobile/home',
    name: 'mobileHome',
    component: VibeLinkMobileShell
  },
  {
    path: '/mobile/mobileMy',
    name: 'mobileMyLayout',
    component: MyLayout,
    children: [
      {
        path: '',
        name: 'mobileMyDefault',
        redirect: '/mobile/mobileMy/editProfile'
      },
      {
        path: 'editProfile',
        name: 'mobileEditProfile',
        component: EditProfile
      },
      {
        path: 'myMessages',
        name: 'mobileMyMessages',
        component: MyMessages
      },
      {
        path: 'editBio',
        name: 'mobileEditBio',
        component: EditBio
      },
      {
        path: 'editBirthday',
        name: 'mobileEditBirthday',
        component: EditBirthday
      },
      {
        path: 'publishCommunity',
        name: 'mobilePublishCommunity',
        component: PublishCommunity
      },
      {
        path: 'settings',
        name: 'MobileSettings',
        component: MobileSettings
      },
      {
        path: 'scanQRCode',
        name: 'mobileQRCode',
        component: MobileQRCode
      },
      {
        path: 'share',
        name: 'mobileShare',
        component: Share
      },
      {
        path: 'SimpleBio',
        name: 'mobileSimpleBio',
        component: SimpleBio
      },
      {
        path: 'aiAssistant',
        name: 'mobileAiAssistant',
        component: AiAssistant
      },
      {
        path: 'myAlbum',
        name: 'mobileMyAlbum',
        component: MyAlbum
      }
    ]
  },
  {
    path: '/mobile/mobileFriends',
    name: 'mobileFriendsLayout',
    component: FriendsLayout,
    children: [
      {
        path: '',
        name: 'mobileFriendsDefault',
        redirect: '/mobile/mobileFriends/addFriends'
      },
      {
        path: 'addFriends',
        name: 'mobileAddFriends',
        component: AddFriends
      },
      {
        path: 'startGroupChat',
        name: 'mobileStartGroupChat',
        component: StartGroupChat
      },
      {
        path: 'confirmAddFriend',
        name: 'mobileConfirmAddFriend',
        component: ConfirmAddFriend
      },
      {
        path: 'confirmAddGroup',
        name: 'mobileConfirmAddGroup',
        component: ConfirmAddGroup
      },
      {
        path: 'friendInfo/:uid',
        name: 'mobileFriendInfo',
        component: FriendInfo
      }
    ]
  },
  {
    path: '/mobile/confirmQRLogin/:ip/:expireTime/:deviceType/:locPlace/:qrId',
    name: 'mobileConfirmQRLogin',
    component: ConfirmQRLogin,
    props: true
  },
  {
    path: '/mobile/myQRCode',
    name: 'mobileMyQRCode',
    component: FriendsLayout,
    children: [
      {
        path: '',
        name: 'mobileMyQRCodePage',
        component: MyQRCode
      }
    ]
  },
  {
    path: '/mobile/rtcCall',
    name: 'rtcCall',
    component: () => import('../mobile/views/rtcCall/index.vue')
  },
  {
    path: '/mobile/dynamic/:id',
    name: 'mobileDynamicDetail',
    component: DynamicDetailPage,
    props: true
  }
]

// 桌面端路由配置
const getDesktopRoutes = (): Array<RouteRecordRaw> => [
  {
    path: '/home',
    name: 'home',
    component: VibeLinkDesktopShell
  },
  {
    path: '/home/:roomId',
    name: 'homeRoom',
    component: VibeLinkDesktopShell
  },
  {
    path: '/legacy-home',
    name: 'legacyHome',
    component: () => import('@/layout/index.vue'),
    children: [
      {
        path: '/message',
        name: 'message',
        component: Message
      },
      {
        path: '/friendsList',
        name: 'friendsList',
        component: FriendsList
      },
      {
        path: '/searchDetails',
        name: 'searchDetails',
        component: SearchDetails
      }
    ]
  },
  {
    path: '/robot',
    name: 'robot',
    component: () => import('@/plugins/robot/index.vue'),
    children: [
      {
        path: '/welcome',
        name: 'welcome',
        component: () => import('@/plugins/robot/views/Welcome.vue')
      },
      {
        path: '/chat',
        name: 'chat',
        component: () => import('@/plugins/robot/views/Chat.vue')
      },
      {
        path: '/chatSettings',
        name: 'chatSettings',
        component: () => import('@/plugins/robot/views/chatSettings/index.vue')
      },
      {
        path: '/imageGeneration',
        name: 'imageGeneration',
        component: () => import('@/plugins/robot/views/ImageGeneration.vue')
      },
      {
        path: '/videoGeneration',
        name: 'videoGeneration',
        component: () => import('@/plugins/robot/views/VideoGeneration.vue')
      }
    ]
  },
  {
    path: '/mail',
    name: 'mail',
    component: () => import('@/views/mailWindow/index.vue')
  },
  {
    path: '/fileManager',
    name: 'fileManager',
    component: () => import('@/views/fileManagerWindow/index.vue')
  },
  {
    path: '/dynamic',
    name: 'dynamic',
    component: () => import('@/plugins/dynamic/index.vue')
  },
  {
    path: '/dynamic/:id',
    name: 'dynamicDetailWithId',
    component: () => import('@/plugins/dynamic/detail.vue')
  },
  {
    path: '/dynamicDetail',
    name: 'dynamicDetail',
    component: () => import('@/plugins/dynamic/detail.vue')
  },
  {
    path: '/onlineStatus',
    name: 'onlineStatus',
    component: () => import('@/views/onlineStatusWindow/index.vue')
  },
  {
    path: '/about',
    name: 'about',
    component: () => import('@/views/aboutWindow/index.vue')
  },
  {
    path: '/alone',
    name: 'alone',
    component: () => import('@/views/homeWindow/message/Alone.vue')
  },
  {
    path: '/sharedScreen',
    name: 'sharedScreen',
    component: () => import('@/views/homeWindow/SharedScreen.vue')
  },
  {
    path: '/modal-invite',
    name: 'modal-invite',
    component: () => import('@/views/modalWindow/index.vue')
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@/views/moreWindow/settings/index.vue'),
    children: [
      {
        path: '/general',
        name: 'general',
        component: () => import('@/views/moreWindow/settings/General.vue')
      },
      {
        path: '/loginSetting',
        name: 'loginSetting',
        component: () => import('@/views/moreWindow/settings/LoginSetting.vue')
      },
      {
        path: '/notification',
        name: 'notification',
        component: () => import('@/views/moreWindow/settings/Notification.vue')
      },
      {
        path: '/versatile',
        name: 'versatile',
        component: () => import('@/views/moreWindow/settings/Versatile.vue')
      },
      {
        path: '/manageStore',
        name: 'manageStore',
        component: () => import('@/views/moreWindow/settings/ManageStore.vue')
      },
      {
        path: '/shortcut',
        name: 'shortcut',
        component: () => import('@/views/moreWindow/settings/Shortcut.vue')
      }
    ]
  },
  {
    path: '/announList/:roomId/:type',
    name: 'announList',
    component: () => import('@/views/announWindow/index.vue')
  },
  {
    path: '/previewFile',
    name: 'previewFile',
    component: () => import('@/views/previewFileWindow/index.vue')
  },
  {
    path: '/chat-history',
    name: 'chat-history',
    component: () => import('@/views/chatHistory/index.vue')
  },
  {
    path: '/rtcCall',
    name: 'rtcCall',
    component: () => import('@/views/callWindow/index.vue')
  },
  // 添加聊天记录窗口路由
  {
    path: '/multiMsg',
    name: 'multiMsg',
    component: () => import('@/views/multiMsgWindow/index.vue')
  },
  {
    path: '/searchFriend',
    name: 'searchFriend',
    component: () => import('@/views/friendWindow/SearchFriend.vue')
  },
  {
    path: '/addFriendVerify',
    name: 'addFriendVerify',
    component: () => import('@/views/friendWindow/AddFriendVerify.vue')
  },
  {
    path: '/addGroupVerify',
    name: 'addGroupVerify',
    component: () => import('@/views/friendWindow/AddGroupVerify.vue')
  }
]

// 通用路由配置（所有平台都需要，包括直接入口与 Tauri 多窗口路由）
const getCommonRoutes = (): Array<RouteRecordRaw> => [
  {
    path: '/',
    name: 'rootEntry',
    redirect: () => (isMobileRuntime() ? '/mobile/message' : '/home')
  },
  {
    path: '/mobile',
    redirect: '/mobile/message'
  },
  {
    path: '/mobile/login',
    redirect: '/mobile/message'
  },
  {
    path: '/mobile/splashscreen',
    redirect: '/mobile/message'
  },
  {
    path: '/mobile/message',
    name: 'mobileMessage',
    component: VibeLinkMobileShell
  },
  {
    path: '/mobile/chat/:roomId?',
    name: 'mobileChatRoomVibe',
    component: VibeLinkMobileShell
  },
  {
    path: '/mobile/bots',
    name: 'mobileBots',
    component: VibeLinkMobileShell
  },
  {
    path: '/mobile/terminal',
    name: 'mobileTerminal',
    component: VibeLinkMobileShell
  },
  {
    path: '/mobile/settings',
    name: 'mobileSettings',
    component: VibeLinkMobileShell
  },
  {
    path: '/manageGroupMember',
    name: 'manageGroupMember',
    component: () => import('@/views/ManageGroupMember.vue')
  },
  {
    path: '/login',
    name: 'login',
    redirect: () => (isMobileRuntime() ? '/mobile/message' : '/home')
  },
  {
    path: '/splashscreen',
    name: 'splashscreen',
    component: Splashscreen
  },
  {
    path: '/register',
    name: 'register',
    component: () => import('@/views/registerWindow/index.vue')
  },
  {
    path: '/forgetPassword',
    name: 'forgetPassword',
    component: () => import('@/views/forgetPasswordWindow/index.vue')
  },
  {
    path: '/qrCode',
    name: 'qrCode',
    component: () => import('@/views/loginWindow/QRCode.vue')
  },
  {
    path: '/network',
    name: 'network',
    component: () => import('@/views/loginWindow/Network.vue')
  },
  {
    path: '/tray',
    name: 'tray',
    component: () => import('@/views/Tray.vue')
  },
  {
    path: '/notify',
    name: 'notify',
    component: () => import('@/views/Notify.vue')
  },
  {
    path: '/update',
    name: 'update',
    component: () => import('@/views/Update.vue')
  },
  {
    path: '/checkupdate',
    name: 'checkupdate',
    component: () => import('@/views/CheckUpdate.vue')
  },
  {
    path: '/capture',
    name: 'capture',
    component: () => import('@/views/Capture.vue')
  },
  {
    path: '/imageViewer',
    name: 'imageViewer',
    component: () => import('@/views/imageViewerWindow/index.vue')
  },
  {
    path: '/videoViewer',
    name: 'videoViewer',
    component: () => import('@/views/videoViewerWindow/index.vue')
  },
  {
    path: '/modal-serviceAgreement',
    name: 'modal-serviceAgreement',
    component: () => import('@/views/agreementWindow/Server.vue')
  },
  {
    path: '/modal-privacyAgreement',
    name: 'modal-privacyAgreement',
    component: () => import('@/views/agreementWindow/Privacy.vue')
  },
  {
    path: '/modal-remoteLogin',
    name: 'modal-remoteLogin',
    component: () => import('@/views/loginWindow/RemoteLoginModal.vue')
  }
]

// 创建所有路由（通用路由 + 平台特定路由）
const getAllRoutes = (): Array<RouteRecordRaw> => {
  const commonRoutes = getCommonRoutes()
  if (isMobile) {
    return [...commonRoutes, ...getMobileRoutes()]
  } else {
    return [...commonRoutes, ...getDesktopRoutes()]
  }
}

// 创建路由
const router: any = createRouter({
  history: createWebHistory(BASE_URL),
  routes: getAllRoutes()
})

// 在创建路由后，添加全局前置守卫
// 为解决 “已声明‘to’，但从未读取其值” 的问题，将 to 参数改为下划线开头表示该参数不会被使用
router.beforeEach(async (_to: RouteLocationNormalized, _from: RouteLocationNormalized, next: NavigationGuardNext) => {
  return next()
})

export default router
