class AppRuntimeConfig {
  const AppRuntimeConfig({
    required this.admob,
    required this.capabilities,
    required this.defaultLocale,
    required this.deepLinkHost,
    required this.featureFlags,
    required this.siteName,
    required this.storeProducts,
    required this.supportedLocales,
    required this.theme,
    this.identity = const {},
  });

  final Map<String, dynamic> admob;
  final Map<String, dynamic> capabilities;
  final String defaultLocale;
  final String? deepLinkHost;
  final Map<String, dynamic> featureFlags;
  final String siteName;
  final Map<String, dynamic> storeProducts;
  final List<String> supportedLocales;
  final Map<String, dynamic> theme;
  final Map<String, dynamic> identity;

  bool get admobEnabled => admob.isNotEmpty && admob['enabled'] != false;
  bool get inAppPurchasesEnabled =>
      capabilities['inAppPurchases'] == true &&
      capabilities['nativePurchaseReceiptVerification'] == true;

  factory AppRuntimeConfig.fromJson(Map<String, dynamic> json) =>
      AppRuntimeConfig(
        admob: Map<String, dynamic>.from(json['admob'] as Map? ?? const {}),
        identity: Map<String, dynamic>.from(
          json['identity'] as Map? ?? const {},
        ),
        capabilities: Map<String, dynamic>.from(
          json['capabilities'] as Map? ?? const {},
        ),
        defaultLocale: json['defaultLocale'] as String? ?? 'en-US',
        deepLinkHost: json['deepLinkHost'] as String?,
        featureFlags: Map<String, dynamic>.from(
          json['featureFlags'] as Map? ?? const {},
        ),
        siteName: json['siteName'] as String? ?? 'Night Flix',
        storeProducts: Map<String, dynamic>.from(
          json['storeProducts'] as Map? ?? const {},
        ),
        supportedLocales: List<String>.from(
          json['supportedLocales'] as List? ?? const ['en-US'],
        ),
        theme: Map<String, dynamic>.from(json['theme'] as Map? ?? const {}),
      );

  static const demo = AppRuntimeConfig(
    admob: {'enabled': true},
    capabilities: {},
    defaultLocale: 'en-US',
    deepLinkHost: null,
    featureFlags: {},
    siteName: 'Night Flix',
    storeProducts: {},
    supportedLocales: [
      'en-US',
      'zh-CN',
      'zh-TW',
      'es-ES',
      'pt-BR',
      'id-ID',
      'th-TH',
      'vi-VN',
      'ja-JP',
      'ko-KR',
      'fr-FR',
      'de-DE',
      'ar-SA',
      'hi-IN',
      'tr-TR',
    ],
    theme: {},
  );
}

class Drama {
  const Drama({
    required this.id,
    required this.title,
    required this.summary,
    required this.totalEpisodes,
    this.coverMediaId,
    this.pointsAmount,
    this.episodes = const [],
    this.palette = 0,
    this.heat = 0,
    this.publishedAt,
  });

  final String id;
  final String title;
  final String summary;
  final int totalEpisodes;
  final String? coverMediaId;
  final int? pointsAmount;
  final List<Episode> episodes;
  final int palette;
  final int heat;
  final DateTime? publishedAt;

  factory Drama.fromJson(Map<String, dynamic> json, {int palette = 0}) => Drama(
    id: json['id'] as String,
    title: json['title'] as String? ?? '',
    summary: json['summary'] as String? ?? '',
    totalEpisodes: json['totalEpisodes'] as int? ?? 0,
    coverMediaId: json['coverMediaId'] as String?,
    pointsAmount: (json['pointsAmount'] as num?)?.toInt(),
    episodes: (json['episodes'] as List? ?? const [])
        .map(
          (value) => Episode.fromJson(Map<String, dynamic>.from(value as Map)),
        )
        .toList(),
    palette: palette,
    heat: (json['heat'] as num?)?.toInt() ?? 0,
    publishedAt: DateTime.tryParse(json['publishedAt'] as String? ?? ''),
  );
}

class Episode {
  const Episode({
    required this.id,
    required this.number,
    required this.title,
    required this.durationSeconds,
    required this.previewSeconds,
    this.pointsAmount,
    this.playbackUrl,
    this.playbackExpiresAt,
    this.access = 'unknown',
    this.tracks = const [],
  });

  final String id;
  final int number;
  final String title;
  final int durationSeconds;
  final int previewSeconds;
  final int? pointsAmount;
  final String? playbackUrl;
  final DateTime? playbackExpiresAt;
  final String access;
  final List<EpisodeTrack> tracks;

  bool get locked =>
      access == 'locked' || (pointsAmount != null && playbackUrl == null);

  bool get preview => access == 'preview';

  factory Episode.fromJson(Map<String, dynamic> json) => Episode(
    id: json['id'] as String,
    number: json['episodeNo'] as int? ?? 1,
    title: json['title'] as String? ?? '',
    durationSeconds: json['durationSeconds'] as int? ?? 0,
    previewSeconds: json['previewSeconds'] as int? ?? 0,
    pointsAmount: (json['pointsAmount'] as num?)?.toInt(),
    tracks: (json['tracks'] as List? ?? const [])
        .map(
          (value) =>
              EpisodeTrack.fromJson(Map<String, dynamic>.from(value as Map)),
        )
        .toList(),
  );

  Episode withPlayback(Map<String, dynamic> json) => Episode(
    id: id,
    number: number,
    title: title,
    durationSeconds: durationSeconds,
    previewSeconds: previewSeconds,
    pointsAmount: pointsAmount,
    playbackUrl: json['url'] as String?,
    playbackExpiresAt: DateTime.tryParse(json['expiresAt'] as String? ?? ''),
    access: json['access'] as String? ?? 'full',
    tracks: tracks,
  );
}

class EpisodeTrack {
  const EpisodeTrack({
    required this.id,
    required this.isDefault,
    required this.label,
    required this.locale,
    required this.type,
  });

  final String id;
  final bool isDefault;
  final String label;
  final String locale;
  final String type;

  bool get isSubtitle => type == 'subtitle';
  bool get isDubbing => type == 'dubbing';

  factory EpisodeTrack.fromJson(Map<String, dynamic> json) => EpisodeTrack(
    id: json['id'] as String,
    isDefault: json['isDefault'] == true,
    label: json['label'] as String? ?? '',
    locale: json['locale'] as String? ?? '',
    type: json['type'] as String? ?? 'subtitle',
  );
}

class SignedTrack {
  const SignedTrack({required this.id, required this.type, required this.url});
  final String id;
  final String type;
  final String url;

  factory SignedTrack.fromJson(Map<String, dynamic> json) => SignedTrack(
    id: json['id'] as String,
    type: json['type'] as String,
    url: json['url'] as String,
  );
}

class DramaInteractionSummary {
  const DramaInteractionSummary({
    required this.commentCount,
    required this.favoriteCount,
    required this.isFavorite,
    required this.isLiked,
    required this.likeCount,
  });

  final int commentCount;
  final int favoriteCount;
  final bool isFavorite;
  final bool isLiked;
  final int likeCount;

  factory DramaInteractionSummary.fromJson(Map<String, dynamic> json) =>
      DramaInteractionSummary(
        commentCount: (json['commentCount'] as num?)?.toInt() ?? 0,
        favoriteCount: (json['favoriteCount'] as num?)?.toInt() ?? 0,
        isFavorite: json['isFavorite'] == true,
        isLiked: json['isLiked'] == true,
        likeCount: (json['likeCount'] as num?)?.toInt() ?? 0,
      );

  DramaInteractionSummary copyWith({
    bool? isFavorite,
    bool? isLiked,
    int? favoriteCount,
    int? likeCount,
  }) => DramaInteractionSummary(
    commentCount: commentCount,
    favoriteCount: favoriteCount ?? this.favoriteCount,
    isFavorite: isFavorite ?? this.isFavorite,
    isLiked: isLiked ?? this.isLiked,
    likeCount: likeCount ?? this.likeCount,
  );
}

class DramaComment {
  const DramaComment({
    required this.id,
    required this.body,
    required this.createdAt,
    this.username,
    this.status = 'visible',
    this.isOwn = false,
  });
  final String id;
  final String body;
  final DateTime createdAt;
  final String? username;
  final String status;
  final bool isOwn;

  factory DramaComment.fromJson(Map<String, dynamic> json) => DramaComment(
    id: json['id'] as String,
    body: json['body'] as String? ?? '',
    createdAt:
        DateTime.tryParse(json['createdAt'] as String? ?? '') ??
        DateTime.fromMillisecondsSinceEpoch(0),
    username: json['username'] as String?,
    status: json['status'] as String? ?? 'visible',
    isOwn: json['isOwn'] == true,
  );
}

class RewardedUnlockChallenge {
  const RewardedUnlockChallenge({
    required this.alreadyUnlocked,
    required this.status,
    this.adUnitId,
    this.challengeId,
  });
  final String? adUnitId;
  final bool alreadyUnlocked;
  final String? challengeId;
  final String status;

  factory RewardedUnlockChallenge.fromJson(Map<String, dynamic> json) =>
      RewardedUnlockChallenge(
        adUnitId: json['adUnitId'] as String?,
        alreadyUnlocked: json['alreadyUnlocked'] == true,
        challengeId: json['challengeId'] as String?,
        status: json['status'] as String? ?? 'pending',
      );
}

class UserSession {
  const UserSession({
    required this.accessToken,
    required this.refreshToken,
    required this.email,
    this.accountId = '',
    this.deviceToken,
    this.deviceId,
  });
  final String accessToken;
  final String refreshToken;
  final String email;
  final String accountId;
  final String? deviceToken;
  final String? deviceId;

  factory UserSession.fromJson(Map<String, dynamic> json, {String email = ''}) {
    final principal = json['principal'] as Map?;
    return UserSession(
      accessToken: json['accessToken'] as String,
      refreshToken: json['refreshToken'] as String,
      email: json['email'] as String? ?? email,
      accountId:
          principal?['accountId'] as String? ??
          json['accountId'] as String? ??
          email,
      deviceToken: json['deviceToken'] as String?,
      deviceId:
          principal?['deviceId'] as String? ?? json['deviceId'] as String?,
    );
  }

  Map<String, dynamic> toJson() => {
    'accessToken': accessToken,
    'refreshToken': refreshToken,
    'email': email,
    'accountId': accountId,
    if (deviceToken != null) 'deviceToken': deviceToken,
    if (deviceId != null) 'deviceId': deviceId,
  };
}

class PointWallet {
  const PointWallet({required this.balancePoints});
  final String balancePoints;
  factory PointWallet.fromJson(Map<String, dynamic> json) =>
      PointWallet(balancePoints: json['balancePoints'] as String? ?? '0');
}

class PlaybackProgress {
  const PlaybackProgress({
    required this.dramaId,
    required this.episodeId,
    required this.positionSeconds,
    this.completed = false,
    required this.updatedAt,
  });
  final String dramaId;
  final String episodeId;
  final int positionSeconds;
  final bool completed;
  final DateTime updatedAt;
  factory PlaybackProgress.fromJson(Map<String, dynamic> json) =>
      PlaybackProgress(
        dramaId: json['dramaId'] as String,
        episodeId: json['episodeId'] as String,
        positionSeconds: (json['positionSeconds'] as num).toInt(),
        completed: json['completed'] == true,
        updatedAt: DateTime.parse(json['updatedAt'] as String),
      );
  Map<String, dynamic> toJson() => {
    'dramaId': dramaId,
    'episodeId': episodeId,
    'positionSeconds': positionSeconds,
    'completed': completed,
    'updatedAt': updatedAt.toIso8601String(),
  };
}

class InboxMessage {
  const InboxMessage({
    required this.body,
    required this.id,
    required this.status,
    required this.title,
    this.deepLink,
  });
  final String body;
  final String id;
  final String status;
  final String title;
  final String? deepLink;
  factory InboxMessage.fromJson(Map<String, dynamic> json) => InboxMessage(
    body: json['body'] as String? ?? '',
    id: json['id'] as String,
    status: json['status'] as String? ?? 'unread',
    title: json['title'] as String? ?? '',
    deepLink: json['deepLink'] as String?,
  );
}
