export interface Category {
  id: string;
  name: string;
  slug: string;
}

export interface Channel {
  id?: string;
  name: string;
  logo: string;
  group: string;
  url: string;
  drmKey?: string;
  licenseType?: string;
  userAgent?: string;
}

export interface Country {
  id: string;
  name: string;
  slug: string;
}

export interface MovieEpisode {
  name: string;
  slug: string;
  filename: string;
  link_embed: string;
  link_m3u8: string;
}

export type ApiSource = 'all' | 'kkphim' | 'ophim' | 'nguonc';

export interface EpisodeServer {
  server_name: string;
  server_data: MovieEpisode[];
  source?: ApiSource;
  sourceLabel?: string;
}

export interface HeroImageOption {
  url: string;
  width?: number;
  height?: number;
  vote_average?: number;
  vote_count?: number;
  iso_639_1?: string;
  primary: boolean;
}

export interface Movie {
  _id?: string;
  id?: string;
  name: string;
  origin_name: string;
  slug: string;
  content?: string;
  type?: 'single' | 'series' | 'hoathinh' | 'tvshows' | string;
  status?: string;
  poster_url: string;
  thumb_url: string;
  backdrop_url?: string;
  logo_url?: string;
  backdrops?: HeroImageOption[];
  logos?: HeroImageOption[];
  color_palette?: {
    primary?: string;
    accent?: string;
    ambientGlow?: string;
    isDark?: boolean;
    textContrast?: string;
  };
  tmdb?: { id?: string; type?: string; season?: any; vote_average?: number; vote_count?: number };
  imdb?: { id?: string; vote_average?: number; vote_count?: number };
  is_copyright?: boolean;
  sub_docquyen?: boolean;
  chieurap?: boolean;
  trailer_url?: string;
  time?: string;
  episode_current?: string;
  episode_total?: string;
  quality?: string;
  lang?: string;
  notify?: string;
  showtimes?: string;
  year?: number;
  view?: number;
  actor?: string[];
  director?: string[];
  category?: Category[];
  country?: Country[];
  episodes?: EpisodeServer[];
  created?: { time: string };
  modified?: { time: string };
  source?: ApiSource;
  sourceLabel?: string;
}

export interface MovieDetailResponse {
  status: boolean;
  msg: string;
  movie: Movie;
  episodes: EpisodeServer[];
}

export interface MovieListPagination {
  totalItems: number;
  totalItemsPerPage: number;
  currentPage: number;
  totalPages: number;
}

export interface MovieListResponse {
  status: boolean;
  items: Movie[];
  pagination?: MovieListPagination;
  titlePage?: string;
  breadCrumb?: Array<{ name: string; slug?: string; isCurrent?: boolean }>;
}

export interface UserProfile {
  id: string;
  name: string;
  avatar: string;
  color: string;
  isKid?: boolean;
  pin?: string;
  isPrimary?: boolean;
  createdAt?: number;
}

export type AccountRole = 'admin' | 'user';

export interface Account {
  id: string; // usually username or uid
  username: string;
  password?: string;
  role: AccountRole;
  displayName: string;
  status: 'active' | 'blocked';
  createdAt: number;
  updatedAt?: number;
  profilesCount?: number;
}

export interface CustomAvatar {
  id: string;
  url: string;
  name: string;
  addedBy?: string;
  createdAt: number;
}

export interface WatchHistoryItem {
  id: string;
  movieSlug: string;
  movieName: string;
  movieOriginName?: string;
  movieThumb: string;
  moviePoster?: string;
  episodeName: string;
  episodeSlug: string;
  serverName: string;
  linkM3u8: string;
  currentTime: number;
  duration: number;
  progressPercent: number;
  updatedAt: number;
}

export interface MyListItem {
  movieSlug: string;
  movieName: string;
  movieOriginName?: string;
  movieThumb: string;
  moviePoster?: string;
  year?: number;
  quality?: string;
  lang?: string;
  episode_current?: string;
  addedAt: number;
}

export type ActiveApp = 'cinema' | 'livetv';

export interface YouTubeChannel {
  id: string;
  title: string;
  handle?: string;
  subscribers?: string;
  videoCount?: string;
  description?: string;
  avatarUrl?: string;
  bannerUrl?: string;
  isSubscribed?: boolean;
  joinedDate?: string;
  viewsTotal?: string;
  links?: { title: string; url: string }[];
  businessEmail?: string;
}

export interface YouTubeVideo {
  id: string;
  title: string;
  channelTitle: string;
  channelId?: string;
  channelAvatar?: string;
  publishedAt?: string;
  description?: string;
  thumbnailUrl: string;
  duration?: string;
  durationSeconds?: number;
  viewCount?: string | number;
  likeCount?: number;
  category?: string;
  isShort?: boolean;
  isLive?: boolean;
}

export interface YouTubePlaylist {
  id: string;
  title: string;
  thumbnailUrl: string;
  videoCount: number;
}

export interface YouTubeUserPlaylist {
  id: string;
  title: string;
  privacy: 'public' | 'unlisted' | 'private';
  videoIds: string[];
  createdAt: number;
  updatedAt?: number;
}

export interface YouTubeHistoryProgress {
  videoId: string;
  currentTime: number;
  duration: number;
  progressPercent: number;
  updatedAt: number;
  video: YouTubeVideo;
}

export interface YouTubeComment {
  id: string;
  user: string;
  avatar: string;
  text: string;
  time: string;
  likes: number;
  isLiked?: boolean;
  isDisliked?: boolean;
  replies?: YouTubeComment[];
}

export interface YouTubeCommunityPost {
  id: string;
  channelTitle: string;
  channelAvatar: string;
  channelId?: string;
  publishedAt: string;
  content: string;
  imageUrl?: string;
  poll?: {
    question: string;
    options: { id: string; text: string; votes: number; userVoted?: boolean }[];
    totalVotes: number;
  };
  likes: number;
  commentsCount: number;
  isLiked?: boolean;
}

  export type NavTab = 'home' | 'series' | 'single' | 'cinema' | 'anime' | 'tv-shows' | 'filter' | 'my-list' | 'history' | 'offline' | 'tv-live' | 'youtube';

export type ApiCategory = 'movie' | 'manga' | 'livetv' | 'youtube' | 'utility';
export type ApiHealthStatus = 'live' | 'slow' | 'down';

export interface SystemApiEndpoint {
  id: string;
  name: string;
  category: ApiCategory;
  baseUrl: string;
  testUrl: string;
  description?: string;
  enabled: boolean;
  isDefault?: boolean;
  priority: number;
  headers?: Record<string, string>;
  lastChecked?: number;
  lastLatencyMs?: number;
  lastStatusCode?: number;
  lastStatus: ApiHealthStatus;
  lastErrorMessage?: string;
  updatedAt?: number;
  updatedBy?: string;
}

export interface ActiveViewerSession {
  sessionId: string;
  accountId: string;
  accountDisplayName?: string;
  profileId: string;
  profileName: string;
  profileAvatar?: string;
  type: 'watching_movie' | 'reading_manga' | 'watching_tv' | 'browsing';
  itemTitle: string;
  itemSubtitle?: string;
  itemCover?: string;
  apiSourceUsed?: string;
  progressPercent?: number;
  currentTime?: number;
  duration?: number;
  lastHeartbeat: number;
  deviceInfo?: string;
}

export type MediaActivityType = 'movie' | 'manga' | 'livetv' | 'youtube' | 'browsing' | 'anime';

export interface UserActivityItem {
  id: string; // e.g. act_${accountId}_${profileId}_${mediaType}_${contentKey}
  accountId: string;
  accountDisplayName: string;
  profileId: string;
  profileName: string;
  profileAvatar?: string;
  mediaType: MediaActivityType;
  contentId: string; // slug, ID, or channel URL
  title: string;
  subtitle?: string;
  coverUrl?: string;
  apiSource?: string;
  progressPercent?: number;
  currentTime?: number; // seconds or page
  duration?: number; // seconds or total pages
  watchedDurationSeconds: number; // accumulated time spent
  firstStartedAt: number;
  lastWatchedAt: number;
  deviceInfo?: string;
  completed?: boolean;
}

export interface UserStats {
  accountId: string;
  accountDisplayName: string;
  totalOnlineSeconds: number;
  totalWatchSeconds: number;
  watchSecondsByMedia: {
    movie: number;
    manga: number;
    livetv: number;
    youtube: number;
  };
  totalSessions: number;
  firstSeenAt: number;
  lastActiveAt: number;
  isOnline?: boolean;
  lastActiveItem?: {
    mediaType: MediaActivityType;
    title: string;
    subtitle?: string;
  };
  totalWatchedItemsCount?: number;
}

export interface AdminNotification {
  id: string;
  message: string;
  targetType: 'all' | 'specific';
  targetAccountIds: string[];
  position: 'top' | 'bottom';
  repeatCount: number;
  speedSeconds?: number;
  active: boolean;
  createdAt: number;
  createdBy: string;
}

export interface AppConfigItem {
  enabled: boolean;
  label: string;
  description: string;
  icon?: string;
  disabledAt?: number;
  disabledBy?: string;
}

export type AppConfig = Record<'cinema' | 'livetv', AppConfigItem>;

export type RoomVisibility = 'public' | 'private';
export type ChatMessageType = 'user' | 'system';

export interface WatchRoom {
  roomId: string;
  filmId: string;
  filmName: string;
  filmThumb: string;
  episode: string;
  episodeSlug: string;
  serverName: string;
  linkM3u8: string;
  hostId: string;
  hostName: string;
  visibility: RoomVisibility;
  passwordHash: string;
  status: RoomStatus;
  viewersCount: number;
  createdAt: number;
  endedAt?: number;
  lastHostSeenAt: number;
}

export interface WatchRoomMember {
  userId: string;
  userName: string;
  userAvatar?: string;
  role: RoomMemberRole;
  joinedAt: number;
  lastSeenAt: number;
}

export interface PlaybackState {
  position: number;
  isPlaying: boolean;
  updatedAt: number;
  lastUpdatedBy: string;
}

export interface RoomChatMessage {
  messageId: string;
  senderId: string;
  senderName: string;
  senderAvatar?: string;
  text: string;
  type: ChatMessageType;
  createdAt: number;
}

export interface RoomListItem {
  roomId: string;
  hostName: string;
  filmName: string;
  episode: string;
  viewersCount: number;
  visibility: RoomVisibility;
  status: RoomStatus;
  createdAt: number;
}

