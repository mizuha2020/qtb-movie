import {
  onValue,
  push,
  ref,
  remove,
  set,
  update,
} from 'firebase/database';
import { rtdb, sanitizeData } from './firebase';
import {
  PlaybackState,
  RoomChatMessage,
  RoomListItem,
  RoomMemberRole,
  RoomStatus,
  RoomVisibility,
  WatchRoom,
  WatchRoomMember,
} from '../types';
import { sha256Hex } from '../utils/sha256';

const ROOMS_PATH = 'rooms';
const USERS_PATH = 'users';
const PRESENCE_PATH = 'wtPresence';

async function hashPassword(password: string): Promise<string> {
  return sha256Hex(password + 'qtb-watch-together-salt');
}

class WatchTogetherService {
  private activeRoomId: string | null = null;
  private unsubRoom: (() => void) | null = null;
  private unsubPresence: (() => void) | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  getActiveRoomId(): string | null {
    return this.activeRoomId;
  }

  async createRoom(params: {
    filmId: string;
    filmName: string;
    filmThumb: string;
    episode: string;
    episodeSlug: string;
    serverName: string;
    linkM3u8: string;
    hostId: string;
    hostName: string;
    password: string;
    visibility: RoomVisibility;
  }): Promise<string> {
    if (this.activeRoomId) {
      throw new Error('Bạn chỉ được tạo 1 phòng đang hoạt động. Vui lòng kết thúc phòng hiện tại trước khi tạo phòng mới.');
    }

    const passwordHash = params.visibility === 'private' ? await hashPassword(params.password) : '';
    const roomId = push(ref(rtdb, ROOMS_PATH)).key!;
    const now = Date.now();

    const room: WatchRoom = {
      roomId,
      filmId: params.filmId,
      filmName: params.filmName,
      filmThumb: params.filmThumb,
      episode: params.episode,
      episodeSlug: params.episodeSlug,
      serverName: params.serverName,
      linkM3u8: params.linkM3u8,
      hostId: params.hostId,
      hostName: params.hostName,
      visibility: params.visibility,
      passwordHash,
      status: 'active',
      viewersCount: 1,
      createdAt: now,
      lastHostSeenAt: now,
    };

    const member: WatchRoomMember = {
      userId: params.hostId,
      userName: params.hostName,
      role: 'host',
      joinedAt: now,
      lastSeenAt: now,
    };

    const initialPlayback: PlaybackState = {
      position: 0,
      isPlaying: false,
      updatedAt: now,
      lastUpdatedBy: params.hostId,
    };

    const roomWithNested = {
      ...room,
      playback: initialPlayback,
      members: {
        [params.hostId]: member,
      },
    };

    const updates: Record<string, any> = {};
    updates[`${ROOMS_PATH}/${roomId}`] = sanitizeData(roomWithNested);
    updates[`${USERS_PATH}/${params.hostId}/activeRoomId`] = roomId;

    await update(ref(rtdb), updates);

    await push(ref(rtdb, `${ROOMS_PATH}/${roomId}/chat`), sanitizeData({
      senderId: 'system',
      senderName: 'Hệ thống',
      text: `${params.hostName} đã tạo phòng xem chung phim "${params.filmName}" tập ${params.episode}.`,
      type: 'system',
      createdAt: Date.now(),
    }));

    this.activeRoomId = roomId;
    this.startPresence(params.hostId);
    this.startHostHeartbeat(roomId, params.hostId);

    return roomId;
  }

  async joinRoom(params: {
    roomId: string;
    userId: string;
    userName: string;
    userAvatar?: string;
    password: string;
    roomData?: WatchRoom;
  }): Promise<void> {
    if (this.activeRoomId) {
      throw new Error('Bạn đang ở trong một phòng khác. Vui lòng rời phòng trước khi tham gia phòng mới.');
    }

    const room = params.roomData || (await this.getRoomSnap(params.roomId) as WatchRoom);
    if (!room) throw new Error('Phòng không tồn tại.');
    if (room.status !== 'active') throw new Error('Phòng đã kết thúc.');

    if (room.visibility === 'private') {
      if (!params.password) throw new Error('Vui lòng nhập mật khẩu phòng.');
      const passwordHash = await hashPassword(params.password);
      if (passwordHash !== room.passwordHash) {
        throw new Error('Mật khẩu sai. Vui lòng thử lại.');
      }
    }

    const rejectedSnap = await new Promise<boolean>((resolve) => {
      const rejectedRef = ref(rtdb, `${ROOMS_PATH}/${params.roomId}/joinRejected/${params.userId}`);
      let unsub: () => void = () => {};
      unsub = onValue(rejectedRef, (snap) => {
        unsub();
        resolve(snap.val() === true);
      }, () => resolve(false));
    });
    if (rejectedSnap) {
      throw new Error('Bạn không thể vào phòng này nữa.');
    }

    const removedSnap = await new Promise<boolean>((resolve) => {
      const removedRef = ref(rtdb, `${ROOMS_PATH}/${params.roomId}/joinRemoved/${params.userId}`);
      let unsub: () => void = () => {};
      unsub = onValue(removedRef, (snap) => {
        unsub();
        resolve(snap.val() === true);
      }, () => resolve(false));
    });
    if (removedSnap) {
      // First rejoin attempt after being kicked: auto-send request
      await remove(ref(rtdb, `${ROOMS_PATH}/${params.roomId}/joinRemoved/${params.userId}`));
      await set(ref(rtdb, `${ROOMS_PATH}/${params.roomId}/pendingJoins/${params.userId}`), sanitizeData({
        userId: params.userId,
        userName: params.userName,
        requestedAt: Date.now(),
      }));
      throw new Error('Yêu cầu vào lại đã được gửi. Vui lòng chờ host duyệt.');
    }

    const now = Date.now();
    const member: WatchRoomMember = {
      userId: params.userId,
      userName: params.userName,
      userAvatar: params.userAvatar,
      role: 'member',
      joinedAt: now,
      lastSeenAt: now,
    };

    const updates: Record<string, any> = {};
    updates[`${ROOMS_PATH}/${params.roomId}/members/${params.userId}`] = sanitizeData(member);
    updates[`${ROOMS_PATH}/${params.roomId}/viewersCount`] = (room.viewersCount || 0) + 1;
    updates[`${USERS_PATH}/${params.userId}/activeRoomId`] = params.roomId;

    await update(ref(rtdb), updates);

    await push(ref(rtdb, `${ROOMS_PATH}/${params.roomId}/chat`), sanitizeData({
      senderId: 'system',
      senderName: 'Hệ thống',
      text: `${params.userName} đã tham gia phòng xem chung.`,
      type: 'system',
      createdAt: Date.now(),
    }));

    this.activeRoomId = params.roomId;
    this.startPresence(params.userId);
  }

  async leaveRoom(userId: string): Promise<void> {
    if (!this.activeRoomId) return;

    const roomId = this.activeRoomId;
    const roomSnap = await this.getRoomSnap(roomId);

    this.stopAll();
    this.activeRoomId = null;

    if (!roomSnap) return;
    const room = roomSnap as WatchRoom;

    const updates: Record<string, any> = {};
    let hostClosedRoom = false;

    if (room.hostId === userId) {
      const members = await this.getMembers(roomId);
      const otherMembers = members.filter((m) => m.userId !== userId);

      if (otherMembers.length > 0) {
        const newHost = otherMembers.sort((a, b) => a.joinedAt - b.joinedAt)[0];
        updates[`${ROOMS_PATH}/${roomId}/hostId`] = newHost.userId;
        updates[`${ROOMS_PATH}/${roomId}/hostName`] = newHost.userName;
        updates[`${ROOMS_PATH}/${roomId}/members/${newHost.userId}/role`] = 'host';
        await push(ref(rtdb, `${ROOMS_PATH}/${roomId}/chat`), sanitizeData({
          senderId: 'system',
          senderName: 'Hệ thống',
          text: `${newHost.userName} đã trở thành host mới.`,
          type: 'system',
          createdAt: Date.now(),
        }));
      } else {
        updates[`${ROOMS_PATH}/${roomId}/status`] = 'closed';
        updates[`${ROOMS_PATH}/${roomId}/endedAt`] = Date.now();
        hostClosedRoom = true;
      }
    }

    const userName = room.hostId === userId ? room.hostName : (await this.getMember(roomId, userId))?.userName || 'Người dùng';
    if (room.hostId !== userId || (room.hostId === userId && !updates[`${ROOMS_PATH}/${roomId}/status`])) {
      await push(ref(rtdb, `${ROOMS_PATH}/${roomId}/chat`), sanitizeData({
        senderId: 'system',
        senderName: 'Hệ thống',
        text: `${userName} đã rời phòng xem chung.`,
        type: 'system',
        createdAt: Date.now(),
      }));
    }

    updates[`${ROOMS_PATH}/${roomId}/members/${userId}`] = null;
    updates[`${ROOMS_PATH}/${roomId}/viewersCount`] = Math.max(0, (room.viewersCount || 1) - 1);
    updates[`${USERS_PATH}/${userId}/activeRoomId`] = null;

    await update(ref(rtdb), updates);

    if (hostClosedRoom) {
      await remove(ref(rtdb, `${ROOMS_PATH}/${roomId}`));
    }
  }

  async endRoom(hostId: string): Promise<void> {
    if (!this.activeRoomId) return;

    const roomId = this.activeRoomId;
    const roomSnap = await this.getRoomSnap(roomId);

    this.stopAll();
    this.activeRoomId = null;

    if (!roomSnap) return;
    const room = roomSnap as WatchRoom;
    if (room.hostId !== hostId) throw new Error('Chỉ host mới có quyền kết thúc phòng.');

    const updates: Record<string, any> = {};
    updates[`${ROOMS_PATH}/${roomId}/status`] = 'closed';
    updates[`${ROOMS_PATH}/${roomId}/endedAt`] = Date.now();
    updates[`${USERS_PATH}/${hostId}/activeRoomId`] = null;

    const members = await this.getMembers(roomId);
    for (const m of members) {
      if (m.userId !== hostId) {
        updates[`${USERS_PATH}/${m.userId}/activeRoomId`] = null;
      }
    }

    await update(ref(rtdb), updates);

    await push(ref(rtdb, `${ROOMS_PATH}/${roomId}/chat`), sanitizeData({
      senderId: 'system',
      senderName: 'Hệ thống',
      text: `Host đã kết thúc phòng xem chung.`,
      type: 'system',
      createdAt: Date.now(),
    }));

    await remove(ref(rtdb, `${ROOMS_PATH}/${roomId}`));
  }

  async verifyPassword(roomId: string, password: string): Promise<boolean> {
    const roomSnap = await this.getRoomSnap(roomId);
    if (!roomSnap) return false;
    const room = roomSnap as WatchRoom;
    const passwordHash = await hashPassword(password);
    return passwordHash === room.passwordHash;
  }

  subscribeRoom(roomId: string, callback: (room: WatchRoom | null) => void): () => void {
    const roomRef = ref(rtdb, `${ROOMS_PATH}/${roomId}`);
    return onValue(roomRef, (snap) => {
      const data = snap.val() as WatchRoom | null;
      callback(data);
    });
  }

  subscribeMembers(roomId: string, callback: (members: WatchRoomMember[]) => void): () => void {
    const membersRef = ref(rtdb, `${ROOMS_PATH}/${roomId}/members`);
    return onValue(membersRef, (snap) => {
      const members: WatchRoomMember[] = [];
      snap.forEach((child) => {
        members.push(child.val() as WatchRoomMember);
      });
      callback(members.sort((a, b) => a.joinedAt - b.joinedAt));
    });
  }

  subscribeActiveRooms(filmId: string, callback: (rooms: RoomListItem[]) => void): () => void {
    const roomsRef = ref(rtdb, ROOMS_PATH);
    return onValue(roomsRef, (snap) => {
      const rooms: RoomListItem[] = [];
      snap.forEach((child) => {
        const room = child.val() as WatchRoom;
        if (room && room.filmId === filmId && room.status === 'active') {
          rooms.push({
            roomId: room.roomId,
            hostName: room.hostName,
            filmName: room.filmName,
            episode: room.episode,
            viewersCount: room.viewersCount || 0,
            visibility: room.visibility,
            status: room.status,
            createdAt: room.createdAt,
          });
        }
      });
      callback(rooms.sort((a, b) => b.createdAt - a.createdAt));
    });
  }

  subscribeAllActiveRooms(callback: (rooms: RoomListItem[]) => void): () => void {
    const roomsRef = ref(rtdb, ROOMS_PATH);
    return onValue(roomsRef, (snap) => {
      const rooms: RoomListItem[] = [];
      snap.forEach((child) => {
        const room = child.val() as WatchRoom;
        if (room && room.status === 'active') {
          rooms.push({
            roomId: room.roomId,
            hostName: room.hostName,
            filmName: room.filmName,
            episode: room.episode,
            viewersCount: room.viewersCount || 0,
            visibility: room.visibility,
            status: room.status,
            createdAt: room.createdAt,
          });
        }
      });
      callback(rooms.sort((a, b) => b.createdAt - a.createdAt));
    });
  }

  subscribePlayback(roomId: string, callback: (state: PlaybackState) => void): () => void {
    const playbackRef = ref(rtdb, `${ROOMS_PATH}/${roomId}/playback`);
    return onValue(playbackRef, (snap) => {
      const data = snap.val() as PlaybackState | null;
      if (data) callback(data);
    });
  }

  async updatePlayback(roomId: string, userId: string, state: Partial<PlaybackState>): Promise<void> {
    await update(ref(rtdb, `${ROOMS_PATH}/${roomId}/playback`), sanitizeData({
      ...state,
      updatedAt: Date.now(),
      lastUpdatedBy: userId,
    }));
  }

  async sendChat(roomId: string, message: Omit<RoomChatMessage, 'messageId' | 'createdAt'>): Promise<void> {
    const chatRef = ref(rtdb, `${ROOMS_PATH}/${roomId}/chat`);
    await push(chatRef, sanitizeData({
      ...message,
      createdAt: Date.now(),
    }));
  }

  subscribeChat(roomId: string, callback: (messages: RoomChatMessage[]) => void): () => void {
    const chatRef = ref(rtdb, `${ROOMS_PATH}/${roomId}/chat`);
    return onValue(chatRef, (snap) => {
      const messages: RoomChatMessage[] = [];
      snap.forEach((child) => {
        const msg = child.val() as RoomChatMessage;
        messages.push({ ...msg, messageId: child.key! });
      });
      callback(messages.slice(-100));
    });
  }

  async removeMember(roomId: string, memberId: string): Promise<void> {
    const updates: Record<string, any> = {};
    updates[`${ROOMS_PATH}/${roomId}/members/${memberId}`] = null;
    updates[`${ROOMS_PATH}/${roomId}/joinRemoved/${memberId}`] = true;
    updates[`${USERS_PATH}/${memberId}/activeRoomId`] = null;
    await update(ref(rtdb), updates);
    await push(ref(rtdb, `${ROOMS_PATH}/${roomId}/chat`), sanitizeData({
      senderId: 'system',
      senderName: 'Hệ thống',
      text: `Một thành viên đã bị host xóa khỏi phòng.`,
      type: 'system',
      createdAt: Date.now(),
    }));
  }

  async banChat(roomId: string, memberId: string): Promise<void> {
    await set(ref(rtdb, `${ROOMS_PATH}/${roomId}/chatBanned/${memberId}`), true);
    await push(ref(rtdb, `${ROOMS_PATH}/${roomId}/chat`), sanitizeData({
      senderId: 'system',
      senderName: 'Hệ thống',
      text: `Một thành viên đã bị cấm chat.`,
      type: 'system',
      createdAt: Date.now(),
    }));
  }

  subscribeChatBanned(roomId: string, userId: string, callback: (banned: boolean) => void): () => void {
    const bannedRef = ref(rtdb, `${ROOMS_PATH}/${roomId}/chatBanned/${userId}`);
    return onValue(bannedRef, (snap) => {
      callback(snap.val() === true);
    });
  }

  subscribeAllChatBanned(roomId: string, callback: (bannedMap: Record<string, boolean>) => void): () => void {
    const bannedRef = ref(rtdb, `${ROOMS_PATH}/${roomId}/chatBanned`);
    return onValue(bannedRef, (snap) => {
      const map: Record<string, boolean> = {};
      snap.forEach((child) => {
        if (child.val() === true) map[child.key!] = true;
      });
      callback(map);
    });
  }

  async unbanChat(roomId: string, memberId: string): Promise<void> {
    await remove(ref(rtdb, `${ROOMS_PATH}/${roomId}/chatBanned/${memberId}`));
    await push(ref(rtdb, `${ROOMS_PATH}/${roomId}/chat`), sanitizeData({
      senderId: 'system',
      senderName: 'Hệ thống',
      text: `Một thành viên đã được host gỡ cấm chat.`,
      type: 'system',
      createdAt: Date.now(),
    }));
  }

  async requestJoin(roomId: string, userId: string, userName: string): Promise<void> {
    await set(ref(rtdb, `${ROOMS_PATH}/${roomId}/pendingJoins/${userId}`), sanitizeData({
      userId,
      userName,
      requestedAt: Date.now(),
    }));
  }

  subscribePendingJoins(roomId: string, callback: (joins: Array<{ userId: string; userName: string; requestedAt: number }>) => void): () => void {
    const pendingRef = ref(rtdb, `${ROOMS_PATH}/${roomId}/pendingJoins`);
    return onValue(pendingRef, (snap) => {
      const joins: Array<{ userId: string; userName: string; requestedAt: number }> = [];
      snap.forEach((child) => {
        joins.push(child.val() as { userId: string; userName: string; requestedAt: number });
      });
      callback(joins.sort((a, b) => a.requestedAt - b.requestedAt));
    });
  }

  async approveJoin(roomId: string, userId: string, roomData: WatchRoom): Promise<void> {
    const now = Date.now();
    const member: WatchRoomMember = {
      userId,
      userName: '',
      role: 'member',
      joinedAt: now,
      lastSeenAt: now,
    };

    const pendingSnap = await new Promise<{ userName: string } | null>((resolve) => {
      const pendingRef = ref(rtdb, `${ROOMS_PATH}/${roomId}/pendingJoins/${userId}`);
      let unsub: () => void = () => {};
      unsub = onValue(pendingRef, (snap) => {
        unsub();
        resolve(snap.val());
      }, () => resolve(null));
    });

    if (pendingSnap) member.userName = pendingSnap.userName;

    const updates: Record<string, any> = {};
    updates[`${ROOMS_PATH}/${roomId}/members/${userId}`] = sanitizeData(member);
    updates[`${ROOMS_PATH}/${roomId}/viewersCount`] = (roomData.viewersCount || 0) + 1;
    updates[`${ROOMS_PATH}/${roomId}/pendingJoins/${userId}`] = null;
    updates[`${ROOMS_PATH}/${roomId}/joinRejected/${userId}`] = null;
    updates[`${ROOMS_PATH}/${roomId}/joinRemoved/${userId}`] = null;
    updates[`${USERS_PATH}/${userId}/activeRoomId`] = roomId;

    await update(ref(rtdb), updates);

    await push(ref(rtdb, `${ROOMS_PATH}/${roomId}/chat`), sanitizeData({
      senderId: 'system',
      senderName: 'Hệ thống',
      text: `${member.userName} đã tham gia phòng xem chung.`,
      type: 'system',
      createdAt: Date.now(),
    }));
  }

  async rejectJoin(roomId: string, userId: string): Promise<void> {
    const updates: Record<string, any> = {};
    updates[`${ROOMS_PATH}/${roomId}/pendingJoins/${userId}`] = null;
    updates[`${ROOMS_PATH}/${roomId}/joinRejected/${userId}`] = true;
    await update(ref(rtdb), updates);
  }

  subscribeRejected(roomId: string, userId: string, callback: (rejected: boolean) => void): () => void {
    const rejectedRef = ref(rtdb, `${ROOMS_PATH}/${roomId}/joinRejected/${userId}`);
    return onValue(rejectedRef, (snap) => {
      callback(snap.val() === true);
    });
  }

  subscribeRemoved(roomId: string, userId: string, callback: (removed: boolean) => void): () => void {
    const removedRef = ref(rtdb, `${ROOMS_PATH}/${roomId}/joinRemoved/${userId}`);
    return onValue(removedRef, (snap) => {
      callback(snap.val() === true);
    });
  }

  async clearJoinRemoved(roomId: string, userId: string): Promise<void> {
    await remove(ref(rtdb, `${ROOMS_PATH}/${roomId}/joinRemoved/${userId}`));
  }

  private startPresence(userId: string): void {
    const presenceRef = ref(rtdb, `${PRESENCE_PATH}/${userId}`);
    set(presenceRef, sanitizeData({ online: true, lastSeenAt: Date.now() })).catch(() => {});

    this.unsubPresence = () => {
      remove(presenceRef).catch(() => {});
    };
  }

  private startHostHeartbeat(roomId: string, hostId: string): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.activeRoomId === roomId) {
        update(ref(rtdb, `${ROOMS_PATH}/${roomId}`), sanitizeData({
          lastHostSeenAt: Date.now(),
        })).catch(() => {});
      }
    }, 60_000);
  }

  private stopAll(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.unsubPresence) {
      this.unsubPresence();
      this.unsubPresence = null;
    }
    if (this.unsubRoom) {
      this.unsubRoom();
      this.unsubRoom = null;
    }
  }

  private async getRoomSnap(roomId: string): Promise<WatchRoom | null> {
    return new Promise((resolve) => {
      const roomRef = ref(rtdb, `${ROOMS_PATH}/${roomId}`);
      let unsub: () => void = () => {};
      unsub = onValue(roomRef, (snap) => {
        unsub();
        resolve(snap.val() as WatchRoom | null);
      }, () => {
        resolve(null);
      });
    });
  }

  private async getMembers(roomId: string): Promise<WatchRoomMember[]> {
    return new Promise((resolve) => {
      const membersRef = ref(rtdb, `${ROOMS_PATH}/${roomId}/members`);
      let unsub: () => void = () => {};
      unsub = onValue(membersRef, (snap) => {
        unsub();
        const members: WatchRoomMember[] = [];
        snap.forEach((child) => {
          members.push(child.val() as WatchRoomMember);
        });
        resolve(members);
      }, () => {
        resolve([]);
      });
    });
  }

  private async getMember(roomId: string, userId: string): Promise<WatchRoomMember | null> {
    return new Promise((resolve) => {
      const memberRef = ref(rtdb, `${ROOMS_PATH}/${roomId}/members/${userId}`);
      let unsub: () => void = () => {};
      unsub = onValue(memberRef, (snap) => {
        unsub();
        resolve(snap.val() as WatchRoomMember | null);
      }, () => {
        resolve(null);
      });
    });
  }

  copyRoomLink(roomId: string): string {
    const url = new URL(window.location.href);
    url.searchParams.set('watchTogether', roomId);
    return url.toString();
  }
}

export const watchTogetherService = new WatchTogetherService();
