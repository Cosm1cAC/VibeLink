package com.vibelink.app

import android.os.Binder
import android.os.IBinder
import android.os.IInterface
import android.os.Parcel
import android.os.RemoteException

interface IVibeLinkShellService : IInterface {
    @Throws(RemoteException::class)
    fun destroy()

    @Throws(RemoteException::class)
    fun execCommand(command: String, timeoutMs: Int): String

    @Throws(RemoteException::class)
    fun getUid(): Int

    abstract class Stub : Binder(), IVibeLinkShellService {
        init {
            attachInterface(this, DESCRIPTOR)
        }

        override fun asBinder(): IBinder = this

        @Throws(RemoteException::class)
        override fun onTransact(code: Int, data: Parcel, reply: Parcel?, flags: Int): Boolean {
            val descriptor = DESCRIPTOR
            if (code == INTERFACE_TRANSACTION) {
                reply?.writeString(descriptor)
                return true
            }
            return when (code) {
                TRANSACTION_destroy -> {
                    data.enforceInterface(descriptor)
                    destroy()
                    reply?.writeNoException()
                    true
                }
                TRANSACTION_execCommand -> {
                    data.enforceInterface(descriptor)
                    val argCommand = data.readString().orEmpty()
                    val argTimeout = data.readInt()
                    val result = execCommand(argCommand, argTimeout)
                    reply?.writeNoException()
                    reply?.writeString(result)
                    true
                }
                TRANSACTION_getUid -> {
                    data.enforceInterface(descriptor)
                    val result = getUid()
                    reply?.writeNoException()
                    reply?.writeInt(result)
                    true
                }
                else -> super.onTransact(code, data, reply, flags)
            }
        }

        private class Proxy(private val remote: IBinder) : IVibeLinkShellService {
            override fun asBinder(): IBinder = remote

            @Throws(RemoteException::class)
            override fun destroy() {
                val data = Parcel.obtain()
                val reply = Parcel.obtain()
                try {
                    data.writeInterfaceToken(DESCRIPTOR)
                    remote.transact(TRANSACTION_destroy, data, reply, 0)
                    reply.readException()
                } finally {
                    reply.recycle()
                    data.recycle()
                }
            }

            @Throws(RemoteException::class)
            override fun execCommand(command: String, timeoutMs: Int): String {
                val data = Parcel.obtain()
                val reply = Parcel.obtain()
                return try {
                    data.writeInterfaceToken(DESCRIPTOR)
                    data.writeString(command)
                    data.writeInt(timeoutMs)
                    remote.transact(TRANSACTION_execCommand, data, reply, 0)
                    reply.readException()
                    reply.readString().orEmpty()
                } finally {
                    reply.recycle()
                    data.recycle()
                }
            }

            @Throws(RemoteException::class)
            override fun getUid(): Int {
                val data = Parcel.obtain()
                val reply = Parcel.obtain()
                return try {
                    data.writeInterfaceToken(DESCRIPTOR)
                    remote.transact(TRANSACTION_getUid, data, reply, 0)
                    reply.readException()
                    reply.readInt()
                } finally {
                    reply.recycle()
                    data.recycle()
                }
            }
        }

        companion object {
            const val DESCRIPTOR = "com.vibelink.app.IVibeLinkShellService"
            const val TRANSACTION_destroy = 16777114
            const val TRANSACTION_execCommand = FIRST_CALL_TRANSACTION + 1 // 2
            const val TRANSACTION_getUid = FIRST_CALL_TRANSACTION + 2 // 3

            fun asInterface(obj: IBinder?): IVibeLinkShellService? {
                if (obj == null) return null
                val iin = obj.queryLocalInterface(DESCRIPTOR)
                return if (iin != null && iin is IVibeLinkShellService) {
                    iin
                } else {
                    Proxy(obj)
                }
            }
        }
    }
}
