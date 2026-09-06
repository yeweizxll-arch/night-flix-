import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:share_plus/share_plus.dart';
import 'package:video_player/video_player.dart';

import 'drama_repository.dart';
import 'app_strings.dart';
import 'app_errors.dart';
import 'models.dart';
import 'account_sheet.dart';
import 'native_purchases.dart';
import 'mobile_links.dart';
import 'tenant_ads.dart';

const _ink = Color(0xff080911);
const _purple = Color(0xff7558ff);
const _pink = Color(0xffff4d8d);
final _playerRouteObserver = RouteObserver<ModalRoute<void>>();

Color _themeColor(dynamic value, Color fallback) {
  if (value is! String || !RegExp(r'^#[0-9a-fA-F]{6}$').hasMatch(value)) {
    return fallback;
  }
  return Color(0xff000000 | int.parse(value.substring(1), radix: 16));
}

class DramaApp extends StatelessWidget {
  const DramaApp({super.key, required this.controller});
  final AppController controller;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) => _materialApp(),
    );
  }

  Widget _materialApp() {
    final primary = _themeColor(
      controller.config.theme['primaryColor'],
      _purple,
    );
    final accent = _themeColor(controller.config.theme['accentColor'], _pink);
    return MaterialApp(
      navigatorObservers: [_playerRouteObserver],
      title: controller.config.siteName,
      debugShowCheckedModeBanner: false,
      locale: localeFromTag(controller.locale),
      supportedLocales: controller.config.supportedLocales
          .map(localeFromTag)
          .toList(),
      localizationsDelegates: const [
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      theme: ThemeData(
        brightness: Brightness.dark,
        scaffoldBackgroundColor: _ink,
        colorScheme: ColorScheme.dark(
          primary: primary,
          secondary: accent,
          surface: const Color(0xff141622),
        ),
        fontFamily: 'SF Pro Display',
        navigationBarTheme: const NavigationBarThemeData(
          backgroundColor: Color(0xee0c0d14),
          indicatorColor: Color(0x337558ff),
          height: 68,
          labelTextStyle: WidgetStatePropertyAll(
            TextStyle(fontSize: 11, fontWeight: FontWeight.w600),
          ),
        ),
        inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: const Color(0xff1b1d2a),
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(14),
            borderSide: BorderSide.none,
          ),
        ),
        useMaterial3: true,
      ),
      home: controller.loading && controller.dramas.isEmpty
          ? const _LaunchScreen()
          : controller.error != null && controller.dramas.isEmpty
          ? _ErrorScreen(message: controller.error!, retry: controller.retry)
          : AppShell(controller: controller),
    );
  }
}

class AppShell extends StatefulWidget {
  const AppShell({super.key, required this.controller});
  final AppController controller;
  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  int index = 0;
  late final NativePurchases purchases;
  late final MobileLinks links;
  int _linkRevision = 0;
  @override
  void initState() {
    super.initState();
    purchases = NativePurchases(widget.controller);
    adsFor(widget.controller).mayShowOpen = () =>
        mounted &&
        index == 0 &&
        !purchases.busy &&
        ModalRoute.of(context)?.isCurrent == true;
    links = MobileLinks(
      widget.controller,
      (id) => unawaited(_openLinkedDrama(id)),
    );
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(links.start());
      if (mounted) unawaited(adsFor(widget.controller).start());
    });
  }

  @override
  void dispose() {
    purchases.dispose();
    links.dispose();
    adsFor(widget.controller).dispose();
    super.dispose();
  }

  Future<void> _openLinkedDrama(String id) async {
    final revision = ++_linkRevision;
    try {
      final drama = await widget.controller.repository.detail(
        Drama.fromJson({'id': id}),
        widget.controller.locale,
      );
      if (!mounted || revision != _linkRevision) return;
      await _openDrama(context, widget.controller, drama);
    } catch (_) {
      if (mounted && revision == _linkRevision) {
        _message(
          context,
          context.tr('contentUnavailable', 'This content is unavailable.'),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final pages = [
      FeedScreen(controller: widget.controller, active: index == 0),
      TheaterScreen(controller: widget.controller),
      RewardsScreen(controller: widget.controller),
      LibraryScreen(controller: widget.controller),
      ProfileScreen(controller: widget.controller),
    ];
    return NativePurchaseScope(
      purchases: purchases,
      child: Scaffold(
        extendBody: index == 0,
        body: IndexedStack(index: index, children: pages),
        bottomNavigationBar: NavigationBar(
          selectedIndex: index,
          onDestinationSelected: (value) => setState(() => index = value),
          destinations: [
            NavigationDestination(
              icon: const Icon(Icons.smart_display_outlined),
              selectedIcon: const Icon(Icons.smart_display),
              label: context.tr('forYou', 'For You'),
            ),
            NavigationDestination(
              icon: const Icon(Icons.local_movies_outlined),
              selectedIcon: const Icon(Icons.local_movies),
              label: context.tr('drama', 'Drama'),
            ),
            NavigationDestination(
              icon: const Icon(Icons.card_giftcard_outlined),
              selectedIcon: const Icon(Icons.card_giftcard),
              label: context.tr('rewards', 'Rewards'),
            ),
            NavigationDestination(
              icon: const Icon(Icons.bookmark_border),
              selectedIcon: const Icon(Icons.bookmark),
              label: context.tr('library', 'Library'),
            ),
            NavigationDestination(
              icon: const Icon(Icons.person_outline),
              selectedIcon: const Icon(Icons.person),
              label: context.tr('me', 'Me'),
            ),
          ],
        ),
      ),
    );
  }
}

class FeedScreen extends StatefulWidget {
  const FeedScreen({super.key, required this.controller, this.active = true});
  final AppController controller;
  final bool active;
  @override
  State<FeedScreen> createState() => _FeedScreenState();
}

class _FeedScreenState extends State<FeedScreen> {
  int current = 0;
  bool followingFeed = false;

  void _selectFeed(bool following) {
    if (followingFeed == following) return;
    setState(() {
      followingFeed = following;
      current = 0;
    });
  }

  @override
  Widget build(BuildContext context) {
    if (widget.controller.dramas.isEmpty) {
      return Center(child: Text(context.tr('noDramas', 'No dramas yet')));
    }
    final dramas = followingFeed
        ? widget.controller.dramas
              .where((drama) => widget.controller.following.contains(drama.id))
              .toList()
        : widget.controller.dramas;
    if (dramas.isEmpty) {
      return ColoredBox(
        color: _ink,
        child: SafeArea(
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(18, 8, 12, 0),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    _feedTab(
                      context.tr('following', 'Following'),
                      followingFeed,
                      () => _selectFeed(true),
                    ),
                    const SizedBox(width: 22),
                    _feedTab(
                      context.tr('forYou', 'For You'),
                      !followingFeed,
                      () => _selectFeed(false),
                    ),
                  ],
                ),
              ),
              Expanded(
                child: Center(
                  child: Padding(
                    padding: const EdgeInsets.all(32),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Icon(
                          Icons.video_library_outlined,
                          size: 54,
                          color: Colors.white38,
                        ),
                        const SizedBox(height: 16),
                        Text(
                          context.tr('noFollowing', 'No followed dramas yet'),
                          style: const TextStyle(
                            fontSize: 20,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          context.tr(
                            'noFollowingHint',
                            'Follow a drama from For You to keep it in this feed.',
                          ),
                          textAlign: TextAlign.center,
                          style: const TextStyle(color: Colors.white60),
                        ),
                        const SizedBox(height: 18),
                        FilledButton(
                          onPressed: () => _selectFeed(false),
                          child: Text(
                            context.tr('browseForYou', 'Browse For You'),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      );
    }
    final activeIndex = current < dramas.length ? current : dramas.length - 1;
    return PageView.builder(
      key: ValueKey(followingFeed),
      scrollDirection: Axis.vertical,
      itemCount: dramas.length,
      onPageChanged: (value) {
        setState(() => current = value);
        widget.controller.markWatched(dramas[value].id);
      },
      itemBuilder: (context, index) => DramaPage(
        key: ValueKey(dramas[index].id),
        active: widget.active && activeIndex == index,
        controller: widget.controller,
        drama: dramas[index],
        followingFeed: followingFeed,
        onFeedChanged: _selectFeed,
      ),
    );
  }
}

class DramaPage extends StatefulWidget {
  const DramaPage({
    super.key,
    required this.active,
    required this.controller,
    required this.drama,
    required this.followingFeed,
    required this.onFeedChanged,
    this.showFeedTabs = true,
  });
  final bool active;
  final AppController controller;
  final Drama drama;
  final bool followingFeed;
  final ValueChanged<bool> onFeedChanged;
  final bool showFeedTabs;
  @override
  State<DramaPage> createState() => _DramaPageState();
}

class _DramaPageState extends State<DramaPage>
    with WidgetsBindingObserver, RouteAware {
  Drama? detail;
  Episode? episode;
  VideoPlayerController? video;
  VideoPlayerController? preloadedVideo;
  VideoPlayerController? dubbingAudio;
  String? preloadedEpisodeId;
  EpisodeTrack? subtitleTrack;
  EpisodeTrack? dubbingTrack;
  DramaInteractionSummary? summary;
  bool loading = false;
  bool switching = false;
  bool previewEnded = false;
  bool completedHandled = false;
  String? playbackError;
  double speed = 1;
  String captionText = '';
  bool syncingDubbing = false;
  DateTime lastDubbingSync = DateTime.fromMillisecondsSinceEpoch(0);
  int _playRevision = 0;
  bool _foreground = true;
  bool _routeVisible = true;
  String? _accountKey;
  DateTime? _preloadedAt;
  Timer? _playbackRefresh;
  Episode? _playingEpisode;
  String? _playingScope;
  DateTime _lastProgressSave = DateTime.fromMillisecondsSinceEpoch(0);
  bool _pausedByAd = false;
  bool _rewardLoading = false;
  bool _wasAdBusy = false;

  void _adsChanged() {
    final busy = adsFor(widget.controller).busy;
    if (busy == _wasAdBusy) return;
    _wasAdBusy = busy;
    if (busy) {
      _pausedByAd =
          video?.value.isPlaying == true &&
          video?.value.isCompleted != true &&
          !completedHandled;
      unawaited(_pausePlayers());
    } else if (_canPlay && (_pausedByAd || video == null)) {
      _pausedByAd = false;
      unawaited(_play(resumeAt: video?.value.position));
    }
  }

  Future<void> _saveVideoProgress({bool completed = false}) async {
    final player = video;
    final selected = _playingEpisode;
    if (player == null ||
        selected == null ||
        !player.value.isInitialized ||
        _playingScope != widget.controller.accountScope) {
      return;
    }
    final seconds = player.value.position.inSeconds.clamp(
      0,
      selected.preview ? selected.previewSeconds : selected.durationSeconds,
    );
    await widget.controller.recordProgress(
      PlaybackProgress(
        dramaId: (detail ?? widget.drama).id,
        episodeId: selected.id,
        positionSeconds: seconds,
        completed: !selected.preview && (completed || player.value.isCompleted),
        updatedAt: DateTime.now(),
      ),
    );
  }

  bool get _canPlay =>
      mounted &&
      widget.active &&
      _foreground &&
      _routeVisible &&
      !adsFor(widget.controller).busy;

  Future<void> _pausePlayers() async {
    _playbackRefresh?.cancel();
    ++_playRevision;
    if (mounted && switching) setState(() => switching = false);
    unawaited(_saveVideoProgress());
    await Future.wait([
      if (video != null) video!.pause(),
      if (dubbingAudio != null) dubbingAudio!.pause(),
    ]);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final route = ModalRoute.of(context);
    if (route != null) _playerRouteObserver.subscribe(this, route);
  }

  @override
  void didPushNext() {
    _routeVisible = false;
    unawaited(_pausePlayers());
  }

  @override
  void didPopNext() {
    _routeVisible = true;
    if (_canPlay) unawaited(_play());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    if (_canPlay) {
      unawaited(_play());
    } else {
      unawaited(_pausePlayers());
    }
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    adsFor(widget.controller).addListener(_adsChanged);
    _accountKey = widget.controller.session?.accountId;
    _load();
  }

  @override
  void didUpdateWidget(covariant DramaPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    final accountChanged = _accountKey != widget.controller.session?.accountId;
    _accountKey = widget.controller.session?.accountId;
    if (!widget.active || accountChanged) unawaited(_pausePlayers());
    if (_canPlay && (!oldWidget.active || accountChanged)) unawaited(_play());
  }

  Future<void> _load() async {
    setState(() => loading = true);
    try {
      final loaded = await widget.controller.loadDetail(widget.drama);
      if (!mounted) return;
      detail = loaded;
      final saved = widget.controller.progress[loaded.id];
      episode =
          loaded.episodes.where((e) => e.id == saved?.episodeId).firstOrNull ??
          loaded.episodes.firstOrNull;
      if (saved?.completed == true) {
        final index = loaded.episodes.indexWhere(
          (e) => e.id == saved!.episodeId,
        );
        episode = loaded.episodes.elementAtOrNull(index + 1) ?? episode;
      }
      if (widget.controller.session != null) {
        try {
          summary = await widget.controller.loadInteractions(loaded.id);
        } catch (_) {
          // Playback remains available if engagement counters fail to load.
        }
      }
      if (_canPlay) await _play();
    } catch (_) {
      // Catalog copy remains useful when a detail request temporarily fails.
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  Future<void> _play({Duration? resumeAt}) async {
    final selected = episode;
    if (selected == null || !_canPlay) return;
    _playbackRefresh?.cancel();
    final revision = ++_playRevision;
    bool current() =>
        _canPlay && revision == _playRevision && episode?.id == selected.id;
    final previous = video;
    final previousAudio = dubbingAudio;
    unawaited(_saveVideoProgress());
    final saved = widget.controller.progress[(detail ?? widget.drama).id];
    final position =
        resumeAt ??
        (previous?.value.isInitialized == true &&
                _playingEpisode?.id == selected.id
            ? previous!.value.position
            : saved?.episodeId == selected.id && saved?.completed != true
            ? Duration(seconds: saved!.positionSeconds)
            : Duration.zero);
    video = null;
    dubbingAudio = null;
    previous?.removeListener(_videoListener);
    await previous?.pause();
    await previousAudio?.pause();
    if (current()) {
      setState(() {
        switching = true;
        playbackError = null;
        previewEnded = false;
        completedHandled = false;
      });
    }
    VideoPlayerController? next;
    VideoPlayerController? audio;
    try {
      await previous?.dispose();
      await previousAudio?.dispose();
      if (!current()) return;
      final playable = await widget.controller.loadPlayback(selected);
      if (!current()) return;
      setState(() => episode = playable);
      if (playable.playbackUrl == null) return;
      subtitleTrack = _availableTrack(playable, subtitleTrack, 'subtitle');
      dubbingTrack = _availableTrack(playable, dubbingTrack, 'dubbing');
      Future<ClosedCaptionFile>? captions;
      if (subtitleTrack != null) {
        try {
          final signed = await widget.controller.loadPlaybackTrack(
            playable,
            subtitleTrack!,
          );
          final text = await widget.controller.repository.downloadTrackText(
            signed.url,
          );
          captions = Future.value(WebVTTCaptionFile(text));
        } catch (_) {
          subtitleTrack = null;
        }
      }
      if (!current()) return;
      final usePreloaded =
          subtitleTrack == null &&
          preloadedEpisodeId == playable.id &&
          preloadedVideo != null &&
          _preloadedAt != null &&
          DateTime.now().difference(_preloadedAt!) <
              const Duration(seconds: 90);
      if (usePreloaded) {
        next = preloadedVideo;
        preloadedVideo = null;
        preloadedEpisodeId = null;
      } else {
        next = _videoController(playable.playbackUrl!, captions: captions);
      }
      if (!next!.value.isInitialized) {
        await next.initialize().timeout(const Duration(seconds: 20));
      }
      if (!current()) return;
      await next.setLooping(false);
      await next.setPlaybackSpeed(speed);
      if (position > Duration.zero &&
          position < next.value.duration &&
          !playable.preview) {
        await next.seekTo(position);
      }
      if (dubbingTrack != null) {
        try {
          final signed = await widget.controller.loadPlaybackTrack(
            playable,
            dubbingTrack!,
          );
          if (!current()) return;
          audio = VideoPlayerController.networkUrl(Uri.parse(signed.url));
          await audio.initialize().timeout(const Duration(seconds: 20));
          await audio.setLooping(false);
          await audio.setPlaybackSpeed(speed);
          await audio.seekTo(next.value.position);
          await next.setVolume(0);
        } catch (_) {
          await audio?.dispose();
          audio = null;
          dubbingTrack = null;
          await next.setVolume(1);
        }
      } else {
        await next.setVolume(1);
      }
      if (!current()) return;
      video = next;
      dubbingAudio = audio;
      _playingEpisode = playable;
      _playingScope = widget.controller.accountScope;
      next.addListener(_videoListener);
      await next.play();
      if (!current()) {
        await next.pause();
        await audio?.pause();
        return;
      }
      await audio?.play();
      if (!current()) {
        await next.pause();
        await audio?.pause();
        return;
      }
      unawaited(widget.controller.markWatched((detail ?? widget.drama).id));
      unawaited(_preloadNext());
      final expires = playable.playbackExpiresAt;
      if (expires != null) {
        final delay =
            expires.difference(DateTime.now()) - const Duration(seconds: 20);
        _playbackRefresh = Timer(
          delay > Duration.zero ? delay : const Duration(seconds: 1),
          () {
            if (current() && video?.value.isPlaying == true) {
              unawaited(_play(resumeAt: video?.value.position));
            }
          },
        );
      }
      if (mounted) setState(() {});
    } catch (cause) {
      if (current()) {
        if (cause is ApiException &&
            cause.statusCode == 403 &&
            (cause.data['access'] == 'locked' ||
                (detail ?? widget.drama).pointsAmount != null)) {
          setState(() => episode = selected.withPlayback({'access': 'locked'}));
        } else {
          setState(() => playbackError = friendlyError(context, cause));
        }
      }
    } finally {
      if (next != null && !identical(video, next)) await next.dispose();
      if (audio != null && !identical(dubbingAudio, audio)) {
        await audio.dispose();
      }
      if (mounted && revision == _playRevision) {
        setState(() => switching = false);
      }
    }
  }

  void _videoListener() {
    final current = video;
    if (current == null || !current.value.isInitialized || !_canPlay) {
      return;
    }
    final nextCaption = current.value.caption.text;
    if (nextCaption != captionText && mounted) {
      setState(() => captionText = nextCaption);
    }
    _syncDubbing(current);
    if (DateTime.now().difference(_lastProgressSave) >=
        const Duration(seconds: 10)) {
      _lastProgressSave = DateTime.now();
      unawaited(_saveVideoProgress());
    }
    if (completedHandled) return;
    final duration = current.value.duration;
    if (duration <= Duration.zero ||
        current.value.position < duration - const Duration(milliseconds: 250)) {
      return;
    }
    completedHandled = true;
    unawaited(_saveVideoProgress(completed: true));
    if (episode?.preview == true) {
      if (mounted) setState(() => previewEnded = true);
    } else {
      _advanceEpisode();
    }
  }

  void _syncDubbing(VideoPlayerController current) {
    final audio = dubbingAudio;
    if (audio == null ||
        syncingDubbing ||
        !audio.value.isInitialized ||
        !_canPlay) {
      return;
    }
    final now = DateTime.now();
    if (now.difference(lastDubbingSync) < const Duration(milliseconds: 750)) {
      return;
    }
    lastDubbingSync = now;
    final drift = (audio.value.position - current.value.position).abs();
    syncingDubbing = true;
    Future<void>(() async {
      if (!_canPlay || audio != dubbingAudio || current != video) return;
      if (drift > const Duration(milliseconds: 300)) {
        await audio.seekTo(current.value.position);
      }
      if (!_canPlay || audio != dubbingAudio || current != video) return;
      if (current.value.isPlaying && !audio.value.isPlaying) {
        await audio.play();
      }
      if ((!_canPlay || !current.value.isPlaying) && audio.value.isPlaying) {
        await audio.pause();
      }
    }).catchError((Object _) {}).whenComplete(() => syncingDubbing = false);
  }

  Future<void> _preloadNext() async {
    final revision = _playRevision;
    final drama = detail;
    final selected = episode;
    if (drama == null || selected == null || !_canPlay) {
      return;
    }
    final index = drama.episodes.indexWhere((item) => item.id == selected.id);
    final nextEpisode = drama.episodes.elementAtOrNull(index + 1);
    await preloadedVideo?.dispose();
    preloadedVideo = null;
    preloadedEpisodeId = null;
    if (nextEpisode == null) return;
    VideoPlayerController? pending;
    try {
      final playable = await widget.controller.loadPlayback(nextEpisode);
      if (!_canPlay ||
          revision != _playRevision ||
          playable.playbackUrl == null) {
        return;
      }
      final controller = pending = _videoController(playable.playbackUrl!);
      await controller.initialize().timeout(const Duration(seconds: 20));
      if (!_canPlay ||
          revision != _playRevision ||
          episode?.id != selected.id) {
        return;
      }
      preloadedVideo = controller;
      preloadedEpisodeId = playable.id;
      _preloadedAt = DateTime.now();
      pending = null;
    } catch (_) {
      // A locked or temporarily unavailable next episode should not interrupt playback.
    } finally {
      await pending?.dispose();
    }
  }

  VideoPlayerController _videoController(
    String url, {
    Future<ClosedCaptionFile>? captions,
  }) {
    const assetPrefix = 'asset://';
    if (url.startsWith(assetPrefix)) {
      return VideoPlayerController.asset(
        url.substring(assetPrefix.length),
        closedCaptionFile: captions,
      );
    }
    return VideoPlayerController.networkUrl(
      Uri.parse(url),
      closedCaptionFile: captions,
    );
  }

  Future<void> _advanceEpisode() async {
    final drama = detail;
    final selected = episode;
    if (drama == null || selected == null || !_canPlay) return;
    final index = drama.episodes.indexWhere((item) => item.id == selected.id);
    final next = drama.episodes.elementAtOrNull(index + 1);
    if (next == null) return;
    final scope = widget.controller.accountScope;
    await adsFor(widget.controller).betweenEpisodes(
      () =>
          _canPlay &&
          episode?.id == selected.id &&
          scope == widget.controller.accountScope,
      content: {'dramaId': drama.id, 'episodeId': selected.id},
    );
    if (!_canPlay ||
        episode?.id != selected.id ||
        scope != widget.controller.accountScope) {
      return;
    }
    episode = next;
    subtitleTrack = null;
    dubbingTrack = null;
    await _play();
  }

  @override
  void dispose() {
    ++_playRevision;
    _playbackRefresh?.cancel();
    unawaited(_saveVideoProgress());
    _playerRouteObserver.unsubscribe(this);
    WidgetsBinding.instance.removeObserver(this);
    adsFor(widget.controller).removeListener(_adsChanged);
    video?.dispose();
    preloadedVideo?.dispose();
    dubbingAudio?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final drama = detail ?? widget.drama;
    final displayDrama = widget.drama;
    final engagement = widget.controller.interactions[drama.id] ?? summary;
    return Stack(
      fit: StackFit.expand,
      children: [
        _CoverImage(controller: widget.controller, drama: drama),
        if (video?.value.isInitialized == true)
          GestureDetector(
            onTap: _togglePlayback,
            child: FittedBox(
              fit: BoxFit.cover,
              child: SizedBox(
                width: video!.value.size.width,
                height: video!.value.size.height,
                child: VideoPlayer(video!),
              ),
            ),
          ),
        const DecoratedBox(
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: [Color(0x22000000), Color(0x00000000), Color(0xdd05060b)],
              stops: [0, .48, 1],
            ),
          ),
        ),
        if (captionText.isNotEmpty)
          Positioned(
            left: 28,
            right: 28,
            bottom: 168,
            child: ClosedCaption(
              text: captionText,
              textStyle: const TextStyle(
                color: Colors.white,
                fontSize: 17,
                fontWeight: FontWeight.w600,
                backgroundColor: Color(0x99000000),
              ),
            ),
          ),
        SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(18, 8, 12, 90),
            child: Column(
              children: [
                if (widget.showFeedTabs)
                  Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      _feedTab(
                        context.tr('following', 'Following'),
                        widget.followingFeed,
                        () => widget.onFeedChanged(true),
                      ),
                      const SizedBox(width: 22),
                      _feedTab(
                        context.tr('forYou', 'For You'),
                        !widget.followingFeed,
                        () => widget.onFeedChanged(false),
                      ),
                      const Spacer(),
                      IconButton(
                        icon: const Icon(Icons.search, size: 27),
                        onPressed: () => _openSearch(context),
                      ),
                    ],
                  ),
                const Spacer(),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            crossAxisAlignment: CrossAxisAlignment.center,
                            children: [
                              Expanded(
                                child: Text(
                                  displayDrama.title,
                                  style: const TextStyle(
                                    fontSize: 24,
                                    fontWeight: FontWeight.w800,
                                  ),
                                ),
                              ),
                              const SizedBox(width: 8),
                              TextButton.icon(
                                onPressed: () =>
                                    widget.controller.toggleFollowing(drama.id),
                                icon: Icon(
                                  widget.controller.following.contains(drama.id)
                                      ? Icons.check
                                      : Icons.add,
                                  size: 17,
                                ),
                                label: Text(
                                  widget.controller.following.contains(drama.id)
                                      ? context.tr('followed', 'Following')
                                      : context.tr('follow', 'Follow'),
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 8),
                          Text(
                            '${context.isChinese ? '第' : 'EP '}${episode?.number ?? 1}${context.isChinese ? '集' : ''}  ·  ${displayDrama.totalEpisodes} ${context.tr('episodeCount', 'episodes')}',
                            style: const TextStyle(
                              fontSize: 13,
                              color: Colors.white70,
                            ),
                          ),
                          const SizedBox(height: 9),
                          Text(
                            displayDrama.summary,
                            maxLines: 3,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontSize: 14, height: 1.35),
                          ),
                          const SizedBox(height: 12),
                          FilledButton.tonalIcon(
                            onPressed: () => _showEpisodes(context, drama),
                            icon: const Icon(Icons.grid_view_rounded, size: 18),
                            label: Text(context.tr('episodes', 'Episodes')),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 12),
                    Column(
                      children: [
                        _action(
                          engagement?.isLiked == true
                              ? Icons.favorite
                              : Icons.favorite_border,
                          _compactCount(engagement?.likeCount ?? 0),
                          () async {
                            if (!await _requireLogin(
                              context,
                              context.tr('like', 'Like'),
                            )) {
                              return;
                            }
                            try {
                              await widget.controller.toggleLike(drama.id);
                            } catch (cause) {
                              if (context.mounted) {
                                _message(
                                  context,
                                  friendlyError(context, cause),
                                );
                              }
                            }
                          },
                        ),
                        _action(
                          widget.controller.favorites.contains(drama.id)
                              ? Icons.bookmark
                              : Icons.bookmark_border,
                          context.tr('save', 'Save'),
                          () async {
                            if (!await _requireLogin(
                              context,
                              context.tr('save', 'Save'),
                            )) {
                              return;
                            }
                            try {
                              await widget.controller.toggleFavorite(drama.id);
                            } catch (cause) {
                              if (context.mounted) {
                                _message(
                                  context,
                                  friendlyError(context, cause),
                                );
                              }
                            }
                          },
                        ),
                        _action(
                          Icons.chat_bubble_outline,
                          _compactCount(engagement?.commentCount ?? 0),
                          () async {
                            if (!await _requireLogin(
                              context,
                              context.tr('comments', 'Comment'),
                            )) {
                              return;
                            }
                            if (!context.mounted) return;
                            await _showComments(context, drama);
                          },
                        ),
                        _action(
                          Icons.share_outlined,
                          context.tr('share', 'Share'),
                          () => _share(context, drama),
                        ),
                      ],
                    ),
                  ],
                ),
                if (loading)
                  const Padding(
                    padding: EdgeInsets.only(top: 8),
                    child: LinearProgressIndicator(minHeight: 2),
                  ),
              ],
            ),
          ),
        ),
        Positioned(
          top: MediaQuery.paddingOf(context).top + 58,
          right: 12,
          child: PopupMenuButton<double>(
            tooltip: context.tr('playbackSpeed', 'Playback speed'),
            initialValue: speed,
            onSelected: (value) async {
              speed = value;
              await video?.setPlaybackSpeed(value);
              if (mounted) setState(() {});
            },
            itemBuilder: (_) => const [1.0, 1.25, 1.5, 2.0]
                .map(
                  (value) =>
                      PopupMenuItem(value: value, child: Text('${value}x')),
                )
                .toList(),
            child: Chip(label: Text('${speed}x')),
          ),
        ),
        Positioned(
          top: MediaQuery.paddingOf(context).top + 58,
          right: 78,
          child: IconButton.filledTonal(
            tooltip: context.tr('tracks', 'Subtitles and dubbing'),
            onPressed: episode?.tracks.isEmpty == false
                ? () => _showTracks(context)
                : null,
            icon: const Icon(Icons.translate),
          ),
        ),
        if (switching) const Center(child: CircularProgressIndicator()),
        if (playbackError != null)
          Center(
            child: FilledButton.tonalIcon(
              onPressed: _play,
              icon: const Icon(Icons.refresh),
              label: Text(context.tr('retryPlayback', 'Retry playback')),
            ),
          ),
        if (episode?.locked == true || previewEnded)
          Center(
            child: _UnlockCard(
              points: episode?.pointsAmount ?? drama.pointsAmount ?? 0,
              buy: () async {
                final authenticated = await _requireLogin(
                  context,
                  context.tr('unlock', 'Unlock'),
                );
                if (!context.mounted) return;
                if (authenticated) {
                  try {
                    final selected = episode;
                    if (selected == null) return;
                    final targetType = selected.pointsAmount != null
                        ? 'episode'
                        : 'drama';
                    final targetId = targetType == 'episode'
                        ? selected.id
                        : drama.id;
                    await widget.controller.unlockWithPoints(
                      targetType,
                      targetId,
                    );
                    await _play();
                  } catch (cause) {
                    if (context.mounted) {
                      _message(context, friendlyError(context, cause));
                    }
                  }
                }
              },
              watchAd: () => _watchAdUnlock(context),
            ),
          ),
      ],
    );
  }

  Future<void> _togglePlayback() async {
    final current = video;
    if (current == null) return;
    if (current.value.isPlaying) {
      await current.pause();
      await dubbingAudio?.pause();
    } else {
      if (!_canPlay) return;
      final expires = _playingEpisode?.playbackExpiresAt;
      if (expires != null &&
          expires.isBefore(DateTime.now().add(const Duration(seconds: 25)))) {
        await _play(resumeAt: current.value.position);
        return;
      }
      await current.play();
      if (!_canPlay || video != current) {
        await current.pause();
        return;
      }
      await dubbingAudio?.play();
    }
  }

  EpisodeTrack? _availableTrack(
    Episode value,
    EpisodeTrack? current,
    String type,
  ) {
    final candidates = value.tracks
        .where((track) => track.type == type)
        .toList();
    if (current != null) {
      final selected = candidates
          .where((track) => track.id == current.id)
          .firstOrNull;
      if (selected != null) return selected;
    }
    return candidates.where((track) => track.isDefault).firstOrNull;
  }

  Future<void> _showTracks(BuildContext context) async {
    final selected = episode;
    if (selected == null) return;
    final result =
        await showModalBottomSheet<
          ({EpisodeTrack? dubbing, EpisodeTrack? subtitle})
        >(
          context: context,
          showDragHandle: true,
          builder: (context) => _TrackPicker(
            dubbing: dubbingTrack,
            episode: selected,
            subtitle: subtitleTrack,
          ),
        );
    if (result == null || !mounted) return;
    final position = video?.value.position;
    subtitleTrack = result.subtitle;
    dubbingTrack = result.dubbing;
    await _play(resumeAt: position);
  }

  Future<bool> _requireLogin(BuildContext context, String action) async {
    if (widget.controller.session != null) return true;
    return _showLogin(
      context,
      widget.controller,
      reason: context.tr(
        'accountHint',
        'Your purchases, favorites and history stay with you.',
      ),
    );
  }

  Future<void> _watchAdUnlock(BuildContext context) async {
    if (_rewardLoading) return;
    final selected = episode;
    if (selected == null ||
        !await _requireLogin(context, context.tr('watchAd', 'Watch ad'))) {
      return;
    }
    if (!context.mounted) return;
    final scope = widget.controller.accountScope;
    bool current() =>
        mounted &&
        widget.active &&
        episode?.id == selected.id &&
        widget.controller.accountScope == scope;
    _rewardLoading = true;
    try {
      final challenge = await widget.controller.createRewardedChallenge(
        selected.id,
      );
      if (challenge.alreadyUnlocked) {
        await _play();
        return;
      }
      final challengeId = challenge.challengeId;
      final adUnitId = challenge.adUnitId;
      if (challengeId == null || adUnitId == null) {
        throw const ApiException('Rewarded ad is unavailable', 409);
      }
      final earned = await adsFor(widget.controller).rewarded(
        adUnitId,
        challengeId,
        () => current() && _canPlay,
        content: {'dramaId': widget.drama.id, 'episodeId': selected.id},
      );
      if (!mounted || !current()) return;
      if (!earned) {
        _message(
          this.context,
          this.context.tr(
            'adUnavailable',
            'Ad unavailable. Please try again later.',
          ),
        );
        return;
      }
      _message(
        this.context,
        this.context.tr('confirmingUnlock', 'Confirming episode unlock…'),
      );
      final granted = await widget.controller.waitForReward(challengeId);
      if (!mounted || !current()) return;
      if (granted) {
        await _play();
      } else {
        _message(
          this.context,
          this.context.tr(
            'unlockDelayed',
            'Unlock confirmation is delayed. Please try again shortly.',
          ),
        );
      }
    } catch (cause) {
      if (mounted) _message(this.context, friendlyError(this.context, cause));
    } finally {
      _rewardLoading = false;
    }
  }

  Future<void> _showComments(BuildContext context, Drama drama) async {
    final input = TextEditingController();
    List<DramaComment> comments;
    try {
      comments = await widget.controller.comments(drama.id);
    } catch (cause) {
      input.dispose();
      if (context.mounted) _message(context, friendlyError(context, cause));
      return;
    }
    if (!context.mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (context) => StatefulBuilder(
        builder: (context, setSheetState) => Padding(
          padding: EdgeInsets.fromLTRB(
            18,
            8,
            18,
            MediaQuery.viewInsetsOf(context).bottom + 12,
          ),
          child: SizedBox(
            height: MediaQuery.sizeOf(context).height * .68,
            child: Column(
              children: [
                Text(
                  '${context.tr('comments', 'Comments')} · ${comments.length}',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 10),
                Expanded(
                  child: comments.isEmpty
                      ? Center(
                          child: Text(
                            context.tr(
                              'firstComment',
                              'Be the first to comment',
                            ),
                          ),
                        )
                      : ListView.builder(
                          itemCount: comments.length,
                          itemBuilder: (_, index) {
                            final comment = comments[index];
                            return ListTile(
                              leading: const CircleAvatar(
                                child: Icon(Icons.person),
                              ),
                              title: Text(
                                comment.username ??
                                    context.tr('viewer', 'Viewer'),
                              ),
                              subtitle: Text(comment.body),
                            );
                          },
                        ),
                ),
                Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: input,
                        maxLength: 2000,
                        decoration: InputDecoration(
                          hintText: context.tr('addComment', 'Add a comment'),
                          counterText: '',
                        ),
                      ),
                    ),
                    IconButton.filled(
                      icon: const Icon(Icons.send),
                      onPressed: () async {
                        final body = input.text.trim();
                        if (body.isEmpty) return;
                        try {
                          final created = await widget.controller.createComment(
                            drama.id,
                            body,
                          );
                          input.clear();
                          setSheetState(
                            () => comments = [...comments, created],
                          );
                          summary = await widget.controller.loadInteractions(
                            drama.id,
                          );
                        } catch (cause) {
                          if (context.mounted) {
                            _message(context, friendlyError(context, cause));
                          }
                        }
                      },
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
    input.dispose();
  }

  Future<void> _share(BuildContext context, Drama drama) async {
    final host = widget.controller.config.deepLinkHost;
    final link = host == null ? '' : ' https://$host/dramas/${drama.id}';
    final box = context.findRenderObject() as RenderBox?;
    await SharePlus.instance.share(
      ShareParams(
        title: drama.title,
        text: '${drama.title}$link',
        sharePositionOrigin: box == null
            ? null
            : box.localToGlobal(Offset.zero) & box.size,
      ),
    );
  }

  void _showEpisodes(BuildContext context, Drama drama) =>
      showModalBottomSheet<void>(
        context: context,
        showDragHandle: true,
        isScrollControlled: true,
        builder: (context) => SizedBox(
          height: MediaQuery.sizeOf(context).height * .62,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.all(20),
                child: Text(
                  '${drama.title} · ${context.tr('episodes', 'Episodes')}',
                  style: Theme.of(context).textTheme.titleLarge
                      ?.copyWith(fontWeight: FontWeight.bold),
                ),
              ),
              Expanded(
                child: GridView.builder(
                  padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
                  gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                    crossAxisCount: 5,
                    mainAxisSpacing: 10,
                    crossAxisSpacing: 10,
                  ),
                  itemCount: drama.episodes.isEmpty
                      ? drama.totalEpisodes
                      : drama.episodes.length,
                  itemBuilder: (context, index) {
                    final item = drama.episodes.elementAtOrNull(index);
                    return FilledButton.tonal(
                      onPressed: () {
                        if (item != null) {
                          episode = item;
                          _play();
                        }
                        Navigator.pop(context);
                      },
                      child: Stack(
                        alignment: Alignment.center,
                        children: [
                          Text('${index + 1}'),
                          if (item?.pointsAmount != null)
                            const Positioned(
                              right: 0,
                              top: 0,
                              child: Icon(Icons.lock, size: 10),
                            ),
                        ],
                      ),
                    );
                  },
                ),
              ),
            ],
          ),
        ),
      );

  void _openSearch(BuildContext context) => showSearch<void>(
    context: context,
    delegate: DramaSearch(widget.controller),
  );
}

class _TrackPicker extends StatefulWidget {
  const _TrackPicker({
    required this.dubbing,
    required this.episode,
    required this.subtitle,
  });
  final EpisodeTrack? dubbing;
  final Episode episode;
  final EpisodeTrack? subtitle;

  @override
  State<_TrackPicker> createState() => _TrackPickerState();
}

class _TrackPickerState extends State<_TrackPicker> {
  EpisodeTrack? dubbing;
  EpisodeTrack? subtitle;

  @override
  void initState() {
    super.initState();
    dubbing = widget.dubbing;
    subtitle = widget.subtitle;
  }

  @override
  Widget build(BuildContext context) {
    final subtitles = widget.episode.tracks.where((track) => track.isSubtitle);
    final dubbings = widget.episode.tracks.where((track) => track.isDubbing);
    return SafeArea(
      child: ListView(
        shrinkWrap: true,
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
        children: [
          Text(
            context.tr('subtitles', 'Subtitles'),
            style: Theme.of(context).textTheme.titleLarge,
          ),
          RadioGroup<String?>(
            groupValue: subtitle?.id,
            onChanged: (id) => setState(() {
              subtitle = id == null
                  ? null
                  : subtitles.firstWhere((track) => track.id == id);
            }),
            child: Column(
              children: [
                RadioListTile<String?>(
                  title: Text(context.tr('off', 'Off')),
                  value: null,
                ),
                ...subtitles.map(
                  (track) => RadioListTile<String?>(
                    title: Text(track.label),
                    subtitle: Text(track.locale),
                    value: track.id,
                  ),
                ),
              ],
            ),
          ),
          const Divider(height: 32),
          Text(
            context.tr('dubbing', 'Dubbing'),
            style: Theme.of(context).textTheme.titleLarge,
          ),
          RadioGroup<String?>(
            groupValue: dubbing?.id,
            onChanged: (id) => setState(() {
              dubbing = id == null
                  ? null
                  : dubbings.firstWhere((track) => track.id == id);
            }),
            child: Column(
              children: [
                RadioListTile<String?>(
                  title: Text(context.tr('originalAudio', 'Original audio')),
                  value: null,
                ),
                ...dubbings.map(
                  (track) => RadioListTile<String?>(
                    title: Text(track.label),
                    subtitle: Text(track.locale),
                    value: track.id,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          FilledButton(
            onPressed: () =>
                Navigator.pop(context, (dubbing: dubbing, subtitle: subtitle)),
            child: Text(context.tr('apply', 'Apply')),
          ),
        ],
      ),
    );
  }
}

Future<void> _openDrama(
  BuildContext context,
  AppController controller,
  Drama drama,
) async {
  await Navigator.of(context).push<void>(
    MaterialPageRoute(
      builder: (context) => Scaffold(
        body: Stack(
          children: [
            DramaPage(
              active: true,
              controller: controller,
              drama: drama,
              followingFeed: false,
              onFeedChanged: (_) {},
              showFeedTabs: false,
            ),
            Positioned(
              top: MediaQuery.paddingOf(context).top + 8,
              left: 8,
              child: const BackButton(),
            ),
          ],
        ),
      ),
    ),
  );
}

class TheaterScreen extends StatefulWidget {
  const TheaterScreen({super.key, required this.controller});
  final AppController controller;
  @override
  State<TheaterScreen> createState() => _TheaterScreenState();
}

class _TheaterScreenState extends State<TheaterScreen> {
  String selected = 'trending';
  Map<String, String> genres = {};
  List<Drama>? filtered;
  bool busy = false;
  String? error;
  int revision = 0;
  String? locale;
  AppController get controller => widget.controller;

  @override
  void initState() {
    super.initState();
    _loadCategories();
  }

  @override
  void didUpdateWidget(covariant TheaterScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (locale != controller.locale) {
      selected = 'trending';
      filtered = null;
      _loadCategories();
    }
  }

  Future<void> _loadCategories() async {
    final requestedLocale = locale = controller.locale;
    try {
      final loaded = await controller.repository.categories(requestedLocale);
      if (mounted && locale == requestedLocale) setState(() => genres = loaded);
    } catch (_) {
      /* The trending catalog remains accessible when categories fail. */
    }
  }

  Future<void> _select(String category) async {
    final request = ++revision;
    setState(() {
      selected = category;
      busy = true;
      error = null;
    });
    try {
      final result = category == 'trending'
          ? null
          : await controller.repository.categoryDramas(
              category,
              controller.locale,
            );
      if (mounted && request == revision) setState(() => filtered = result);
    } catch (cause) {
      if (mounted && request == revision) {
        setState(() => error = friendlyError(context, cause));
      }
    } finally {
      if (mounted && request == revision) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final items = filtered ?? controller.dramas;
    return SafeArea(
      child: CustomScrollView(
        slivers: [
          SliverAppBar.large(
            title: Text(context.tr('dramaTheater', 'Drama Theater')),
            backgroundColor: _ink,
          ),
          SliverToBoxAdapter(child: NativeAdPlacement(controller: controller)),
          SliverToBoxAdapter(
            child: SizedBox(
              height: 48,
              child: ListView(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                scrollDirection: Axis.horizontal,
                children:
                    {'trending': context.tr('trending', 'Trending'), ...genres}
                        .entries
                        .map(
                          (item) => Padding(
                            padding: const EdgeInsets.only(right: 8),
                            child: FilterChip(
                              label: Text(
                                controller.repository.demoMode
                                    ? context.tr(item.key, item.value)
                                    : item.value,
                              ),
                              selected: item.key == selected,
                              onSelected: (_) => _select(item.key),
                            ),
                          ),
                        )
                        .toList(),
              ),
            ),
          ),
          if (busy) const SliverToBoxAdapter(child: LinearProgressIndicator()),
          if (error != null)
            SliverToBoxAdapter(
              child: TextButton(
                onPressed: () => _select(selected),
                child: Text(context.tr('tryAgain', 'Try again')),
              ),
            ),
          if (items.isEmpty && !busy)
            SliverFillRemaining(
              child: Center(
                child: Text(context.tr('noDramas', 'No dramas yet')),
              ),
            ),
          SliverPadding(
            padding: const EdgeInsets.all(16),
            sliver: SliverGrid.builder(
              gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                crossAxisCount: 2,
                childAspectRatio: .62,
                crossAxisSpacing: 12,
                mainAxisSpacing: 18,
              ),
              itemCount: items.length,
              itemBuilder: (context, index) {
                final drama = items[index];
                return InkWell(
                  onTap: () => _openDrama(context, controller, drama),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(
                        child: ClipRRect(
                          borderRadius: BorderRadius.circular(16),
                          child: _CoverImage(
                            controller: controller,
                            drama: drama,
                          ),
                        ),
                      ),
                      const SizedBox(height: 9),
                      Text(
                        drama.title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontWeight: FontWeight.w700),
                      ),
                      Text(
                        '${drama.totalEpisodes} ${context.tr('episodeCount', 'episodes')}',
                        style: const TextStyle(
                          color: Colors.white54,
                          fontSize: 12,
                        ),
                      ),
                    ],
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

class RewardsScreen extends StatefulWidget {
  const RewardsScreen({super.key, required this.controller});
  final AppController controller;
  @override
  State<RewardsScreen> createState() => _RewardsScreenState();
}

class _RewardsScreenState extends State<RewardsScreen> {
  @override
  Widget build(BuildContext context) => SafeArea(
    child: ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Text(
          context.tr('rewards', 'Rewards'),
          style: const TextStyle(fontSize: 32, fontWeight: FontWeight.w800),
        ),
        const SizedBox(height: 18),
        FutureBuilder<PointWallet>(
          future: widget.controller.session == null
              ? null
              : widget.controller.wallet(),
          builder: (context, snapshot) => Container(
            padding: const EdgeInsets.all(22),
            decoration: BoxDecoration(
              gradient: const LinearGradient(colors: [_purple, _pink]),
              borderRadius: BorderRadius.circular(22),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  context.tr('coinBalance', 'Coin balance'),
                  style: const TextStyle(fontSize: 14, color: Colors.white70),
                ),
                const SizedBox(height: 4),
                Text(
                  widget.controller.session == null
                      ? context.tr('signInToView', 'Sign in to view')
                      : snapshot.hasError
                      ? context.tr('unavailable', 'Unavailable')
                      : snapshot.data?.balancePoints ?? '…',
                  style: const TextStyle(
                    fontSize: 28,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 26),
        ListTile(
          leading: const Icon(Icons.play_circle_fill),
          title: Text(context.tr('rewardUnlocks', 'Rewarded episode unlocks')),
          subtitle: Text(
            context.tr(
              'rewardUnlocksHint',
              'Watch an ad on a locked episode to unlock that episode directly.',
            ),
          ),
        ),
        const SizedBox(height: 24),
        FilledButton(
          onPressed: () => _openStore(context),
          child: Text(context.tr('moreCoins', 'Get more coins')),
        ),
      ],
    ),
  );

  Future<void> _openStore(BuildContext context) async {
    await _openStoreForController(context, widget.controller);
  }
}

class LibraryScreen extends StatelessWidget {
  const LibraryScreen({super.key, required this.controller});
  final AppController controller;

  @override
  Widget build(BuildContext context) {
    final all = {
      for (final d in controller.dramas) d.id: d,
      ...controller.libraryDramas,
    };
    final saved = all.values
        .where((drama) => controller.favorites.contains(drama.id))
        .toList();
    final watched = controller.history
        .map((id) => all[id])
        .whereType<Drama>()
        .toList();
    return SafeArea(
      child: DefaultTabController(
        length: 2,
        child: Column(
          children: [
            Padding(
              padding: EdgeInsets.fromLTRB(20, 20, 20, 8),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  context.tr('myLibrary', 'My Library'),
                  style: const TextStyle(
                    fontSize: 30,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
            ),
            TabBar(
              tabs: [
                Tab(text: context.tr('watchHistory', 'Watch History')),
                Tab(text: context.tr('favorites', 'Favorites')),
              ],
            ),
            Expanded(
              child: TabBarView(
                children: [
                  _DramaList(controller: controller, items: watched),
                  _DramaList(controller: controller, items: saved),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key, required this.controller});
  final AppController controller;

  @override
  Widget build(BuildContext context) => SafeArea(
    child: ListView(
      padding: const EdgeInsets.all(20),
      children: [
        const SizedBox(height: 12),
        Row(
          children: [
            const CircleAvatar(
              radius: 34,
              backgroundColor: _purple,
              child: Icon(Icons.person, size: 36),
            ),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    controller.session == null
                        ? context.tr('guest', 'Guest')
                        : controller.session!.email.isNotEmpty
                        ? controller.session!.email
                        : context.tr('accountConnected', 'Account connected'),
                    style: const TextStyle(
                      fontSize: 22,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  Text(
                    controller.session == null
                        ? context.tr(
                            'signInSync',
                            'Sign in to sync purchases and history',
                          )
                        : context.tr('accountConnected', 'Account connected'),
                    style: const TextStyle(color: Colors.white60),
                  ),
                ],
              ),
            ),
            if (controller.session == null)
              FilledButton(
                onPressed: () => _showLogin(context, controller),
                child: Text(context.tr('signIn', 'Sign in')),
              ),
          ],
        ),
        const SizedBox(height: 26),
        _profileTile(
          Icons.workspace_premium_outlined,
          context.tr('membership', 'Membership'),
          context.tr('plansBenefits', 'Plans and benefits'),
          onTap: () => _openStoreForController(context, controller),
        ),
        _profileTile(
          Icons.monetization_on_outlined,
          context.tr('coins', 'Coins'),
          context.tr('balanceTransactions', 'Balance and transactions'),
          onTap: () => _showWallet(context, controller),
        ),
        _profileTile(
          Icons.notifications_none,
          context.tr('messages', 'Messages'),
          context.tr('updatesReplies', 'Updates and replies'),
          onTap: () => _showInbox(context, controller),
        ),
        _profileTile(
          Icons.language,
          context.tr('language', 'Language'),
          localeNames[controller.locale] ?? controller.locale,
          onTap: () => _languageSheet(context, controller),
        ),
        _profileTile(
          Icons.settings_outlined,
          context.tr('settings', 'Settings'),
          context.tr('settingsHint', 'Playback, subtitles and privacy'),
        ),
        ListenableBuilder(
          listenable: adsFor(controller),
          builder: (context, _) => adsFor(controller).privacyRequired
              ? _profileTile(
                  Icons.privacy_tip_outlined,
                  context.tr('adPrivacy', 'Ad privacy choices'),
                  '',
                  onTap: () async {
                    try {
                      await adsFor(controller).privacyOptions();
                    } catch (cause) {
                      if (context.mounted) {
                        _message(context, friendlyError(context, cause));
                      }
                    }
                  },
                )
              : const SizedBox.shrink(),
        ),
        _profileTile(
          Icons.help_outline,
          context.tr('help', 'Help & support'),
          context.tr('helpHint', 'FAQ and contact'),
        ),
        if (controller.session != null)
          Padding(
            padding: const EdgeInsets.only(top: 18),
            child: OutlinedButton(
              onPressed: () async {
                try {
                  await controller.logout();
                } catch (cause) {
                  if (context.mounted) {
                    _message(context, friendlyError(context, cause));
                  }
                }
              },
              child: Text(context.tr('signOut', 'Sign out')),
            ),
          ),
      ],
    ),
  );
}

class DramaSearch extends SearchDelegate<void> {
  DramaSearch(this.controller);
  final AppController controller;
  @override
  String get searchFieldLabel => translateAppString(
    localeFromTag(controller.locale),
    'searchDramas',
    'Search dramas',
  );
  @override
  List<Widget> buildActions(BuildContext context) => [
    IconButton(onPressed: () => query = '', icon: const Icon(Icons.clear)),
  ];
  @override
  Widget buildLeading(BuildContext context) => IconButton(
    onPressed: () => close(context, null),
    icon: const Icon(Icons.arrow_back),
  );
  @override
  Widget buildResults(BuildContext context) => _results();
  @override
  Widget buildSuggestions(BuildContext context) => _results();
  Widget _results() => _SearchResults(controller: controller, query: query);
}

class _SearchResults extends StatefulWidget {
  const _SearchResults({required this.controller, required this.query});
  final AppController controller;
  final String query;
  @override
  State<_SearchResults> createState() => _SearchResultsState();
}

class _SearchResultsState extends State<_SearchResults> {
  Timer? _timer;
  int _revision = 0;
  List<Drama> _items = [];
  bool _loading = true;
  Object? _error;
  @override
  void initState() {
    super.initState();
    _search();
  }

  @override
  void didUpdateWidget(covariant _SearchResults oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.query != widget.query ||
        oldWidget.controller != widget.controller) {
      _search();
    }
  }

  void _search() {
    _timer?.cancel();
    final revision = ++_revision;
    _loading = true;
    _error = null;
    _timer = Timer(const Duration(milliseconds: 300), () async {
      try {
        final items = await widget.controller.repository.dramas(
          locale: widget.controller.locale,
          query: widget.query,
        );
        if (mounted && revision == _revision) {
          setState(() {
            _items = items;
            _loading = false;
          });
        }
      } catch (cause) {
        if (mounted && revision == _revision) {
          setState(() {
            _error = cause;
            _loading = false;
          });
        }
      }
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    _revision++;
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return Center(
        child: TextButton(
          onPressed: () => setState(_search),
          child: Text(friendlyError(context, _error!)),
        ),
      );
    }
    return _DramaList(controller: widget.controller, items: _items);
  }
}

class _DramaList extends StatelessWidget {
  const _DramaList({required this.controller, required this.items});
  final AppController controller;
  final List<Drama> items;
  @override
  Widget build(BuildContext context) => items.isEmpty
      ? Center(
          child: Text(
            context.tr('nothingHere', 'Nothing here yet'),
            style: const TextStyle(color: Colors.white54),
          ),
        )
      : ListView.separated(
          padding: const EdgeInsets.all(16),
          itemCount: items.length,
          separatorBuilder: (_, _) => const SizedBox(height: 12),
          itemBuilder: (context, index) {
            final drama = items[index];
            return InkWell(
              onTap: () => _openDrama(context, controller, drama),
              child: Row(
                children: [
                  SizedBox(
                    width: 82,
                    height: 112,
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(12),
                      child: _CoverImage(controller: controller, drama: drama),
                    ),
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          drama.title,
                          style: const TextStyle(
                            fontSize: 17,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                        const SizedBox(height: 6),
                        Text(
                          '${drama.totalEpisodes} ${context.tr('episodeCount', 'episodes')}',
                          style: const TextStyle(color: Colors.white54),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          drama.summary,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            );
          },
        );
}

class _CoverImage extends StatelessWidget {
  const _CoverImage({required this.controller, required this.drama});
  final AppController controller;
  final Drama drama;

  @override
  Widget build(BuildContext context) {
    final mediaId = drama.coverMediaId;
    if (mediaId == null) return _Backdrop(palette: drama.palette);
    return FutureBuilder<String?>(
      future: controller.assetUrl(mediaId),
      builder: (context, snapshot) {
        final url = snapshot.data;
        if (url == null) return _Backdrop(palette: drama.palette);
        return Image.network(
          url,
          fit: BoxFit.cover,
          errorBuilder: (_, _, _) => _Backdrop(palette: drama.palette),
        );
      },
    );
  }
}

class _Backdrop extends StatelessWidget {
  const _Backdrop({required this.palette});
  final int palette;
  @override
  Widget build(BuildContext context) {
    const palettes = [
      [Color(0xff442661), Color(0xff12192e), Color(0xff7b315c)],
      [Color(0xff162b4e), Color(0xff5f2945), Color(0xff15131e)],
      [Color(0xff273d3c), Color(0xff382349), Color(0xff10141d)],
    ];
    final colors = palettes[palette % palettes.length];
    return DecoratedBox(
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: colors,
        ),
      ),
      child: Center(
        child: Opacity(
          opacity: .2,
          child: Icon(
            palette.isEven ? Icons.auto_awesome : Icons.local_movies,
            size: 110,
          ),
        ),
      ),
    );
  }
}

class _UnlockCard extends StatelessWidget {
  const _UnlockCard({
    required this.points,
    required this.buy,
    required this.watchAd,
  });
  final int points;
  final VoidCallback buy;
  final VoidCallback watchAd;
  @override
  Widget build(BuildContext context) => Container(
    width: 270,
    padding: const EdgeInsets.all(22),
    decoration: BoxDecoration(
      color: const Color(0xee171824),
      borderRadius: BorderRadius.circular(22),
    ),
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        const Icon(Icons.lock_rounded, size: 36, color: _pink),
        const SizedBox(height: 12),
        Text(
          context.tr('continueWatching', 'Continue watching'),
          style: const TextStyle(fontSize: 19, fontWeight: FontWeight.bold),
        ),
        const SizedBox(height: 6),
        Text(
          points > 0
              ? "${context.tr('unlock', 'Unlock')} · $points ${context.tr('coins', 'Coins')}"
              : context.tr('chooseUnlock', 'Choose an unlock option'),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 16),
        SizedBox(
          width: double.infinity,
          child: FilledButton.icon(
            onPressed: watchAd,
            icon: const Icon(Icons.play_circle_fill),
            label: Text(
              context.tr('watchAdUnlock', 'Watch ad · unlock 1 episode'),
            ),
          ),
        ),
        const SizedBox(height: 8),
        SizedBox(
          width: double.infinity,
          child: OutlinedButton(
            onPressed: buy,
            child: Text(
              points > 0
                  ? "${context.tr('unlock', 'Unlock')} · $points ${context.tr('coins', 'Coins')}"
                  : context.tr('purchaseOptions', 'Purchase options'),
            ),
          ),
        ),
      ],
    ),
  );
}

class _LaunchScreen extends StatelessWidget {
  const _LaunchScreen();
  @override
  Widget build(BuildContext context) => const Scaffold(
    body: Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          ClipRRect(
            borderRadius: BorderRadius.all(Radius.circular(22)),
            child: Image(
              image: AssetImage('assets/brand/app-icon-master.png'),
              width: 88,
              height: 88,
              fit: BoxFit.cover,
            ),
          ),
          SizedBox(height: 12),
          Text(
            'NIGHT FLIX',
            style: TextStyle(
              fontSize: 22,
              fontWeight: FontWeight.w900,
              letterSpacing: 3,
            ),
          ),
          SizedBox(height: 24),
          SizedBox(width: 120, child: LinearProgressIndicator()),
        ],
      ),
    ),
  );
}

class _ErrorScreen extends StatelessWidget {
  const _ErrorScreen({required this.message, required this.retry});
  final String message;
  final VoidCallback retry;
  @override
  Widget build(BuildContext context) => Scaffold(
    body: Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.cloud_off, size: 48),
            const SizedBox(height: 16),
            Text(message, textAlign: TextAlign.center),
            const SizedBox(height: 16),
            FilledButton(
              onPressed: retry,
              child: Text(context.tr('tryAgain', 'Try again')),
            ),
          ],
        ),
      ),
    ),
  );
}

Widget _feedTab(String label, bool selected, VoidCallback onTap) => Semantics(
  selected: selected,
  button: true,
  child: InkWell(
    borderRadius: BorderRadius.circular(12),
    onTap: onTap,
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 6),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            label,
            style: TextStyle(
              fontSize: selected ? 17 : 15,
              fontWeight: selected ? FontWeight.w800 : FontWeight.w500,
              color: selected ? Colors.white : Colors.white60,
            ),
          ),
          const SizedBox(height: 4),
          if (selected)
            Container(
              width: 20,
              height: 3,
              decoration: BoxDecoration(
                color: _pink,
                borderRadius: BorderRadius.circular(3),
              ),
            ),
        ],
      ),
    ),
  ),
);

Widget _action(IconData icon, String label, VoidCallback action) => Padding(
  padding: const EdgeInsets.only(top: 15),
  child: Column(
    children: [
      IconButton.filledTonal(onPressed: action, icon: Icon(icon, size: 27)),
      Text(
        label,
        style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w600),
      ),
    ],
  ),
);

Widget _profileTile(
  IconData icon,
  String title,
  String subtitle, {
  VoidCallback? onTap,
}) => Card(
  child: ListTile(
    leading: Icon(icon),
    title: Text(title),
    subtitle: Text(subtitle),
    trailing: const Icon(Icons.chevron_right),
    onTap: onTap,
  ),
);

Future<bool> _showLogin(
  BuildContext context,
  AppController controller, {
  String? reason,
}) => showAccountSheet(context, controller, reason: reason);

void _languageSheet(BuildContext context, AppController controller) =>
    showModalBottomSheet<void>(
      context: context,
      builder: (context) => ListView(
        shrinkWrap: true,
        padding: const EdgeInsets.all(20),
        children: [
          Text(
            context.tr('language', 'Language'),
            style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold),
          ),
          ...controller.config.supportedLocales.map(
            (locale) => ListTile(
              selected: locale == controller.locale,
              title: Text(localeNames[locale] ?? locale),
              trailing: locale == controller.locale
                  ? const Icon(Icons.check, color: _purple)
                  : null,
              onTap: () async {
                try {
                  await controller.setLocale(locale);
                  if (context.mounted) Navigator.pop(context);
                } catch (error) {
                  if (context.mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(content: Text(friendlyError(context, error))),
                    );
                  }
                }
              },
            ),
          ),
        ],
      ),
    );

Future<void> _openStoreForController(
  BuildContext context,
  AppController controller,
) async {
  if (controller.session == null &&
      !await _showLogin(
        context,
        controller,
        reason: context.tr(
          'accountHint',
          'Your purchases, favorites and history stay with you.',
        ),
      )) {
    return;
  }
  if (!context.mounted) return;
  if (!controller.config.inAppPurchasesEnabled) {
    _message(
      context,
      context.tr(
        'storeUnavailable',
        'Store unavailable. Please try again later.',
      ),
    );
    return;
  }
  final purchases = NativePurchaseScope.of(context) ?? purchasesFor(controller);
  if (purchases == null) return;
  try {
    await showNativeStore(context, purchases);
  } catch (_) {
    if (context.mounted) {
      _message(
        context,
        context.tr(
          'storeUnavailable',
          'Store unavailable. Please try again later.',
        ),
      );
    }
  }
}

Future<void> _showWallet(BuildContext context, AppController controller) async {
  if (controller.session == null && !await _showLogin(context, controller)) {
    return;
  }
  if (!context.mounted) return;
  try {
    final wallet = await controller.wallet();
    if (!context.mounted) return;
    await showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(context.tr('coinBalance', 'Coin balance')),
        content: Text(
          wallet.balancePoints,
          style: const TextStyle(fontSize: 30, fontWeight: FontWeight.bold),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: Text(context.tr('close', 'Close')),
          ),
        ],
      ),
    );
  } catch (cause) {
    if (context.mounted) _message(context, friendlyError(context, cause));
  }
}

Future<void> _showInbox(BuildContext context, AppController controller) async {
  if (controller.session == null && !await _showLogin(context, controller)) {
    return;
  }
  if (!context.mounted) return;
  try {
    var items = await controller.inbox();
    if (!context.mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (context) => StatefulBuilder(
        builder: (context, setState) => SizedBox(
          height: MediaQuery.sizeOf(context).height * .72,
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.all(18),
                child: Text(
                  context.tr('messages', 'Messages'),
                  style: const TextStyle(
                    fontSize: 24,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
              Expanded(
                child: items.isEmpty
                    ? Center(
                        child: Text(
                          context.tr('nothingHere', 'Nothing here yet'),
                        ),
                      )
                    : ListView.builder(
                        itemCount: items.length,
                        itemBuilder: (context, index) {
                          final item = items[index];
                          return ListTile(
                            leading: Icon(
                              item.status == 'unread'
                                  ? Icons.mark_email_unread
                                  : Icons.drafts_outlined,
                            ),
                            title: Text(
                              item.title,
                              style: TextStyle(
                                fontWeight: item.status == 'unread'
                                    ? FontWeight.bold
                                    : FontWeight.normal,
                              ),
                            ),
                            subtitle: Text(
                              item.body,
                              maxLines: 3,
                              overflow: TextOverflow.ellipsis,
                            ),
                            onTap: item.status == 'unread'
                                ? () async {
                                    final scope = controller.accountScope;
                                    try {
                                      await controller.markMessageRead(item.id);
                                    } catch (cause) {
                                      if (context.mounted) {
                                        _message(
                                          context,
                                          friendlyError(context, cause),
                                        );
                                      }
                                      return;
                                    }
                                    if (!context.mounted ||
                                        controller.accountScope != scope) {
                                      return;
                                    }
                                    final changed = InboxMessage(
                                      body: item.body,
                                      id: item.id,
                                      status: 'read',
                                      title: item.title,
                                    );
                                    final updated = [...items];
                                    updated[index] = changed;
                                    setState(() => items = updated);
                                  }
                                : null,
                          );
                        },
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  } catch (cause) {
    if (context.mounted) _message(context, friendlyError(context, cause));
  }
}

void _message(BuildContext context, String value) =>
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(value), behavior: SnackBarBehavior.floating),
    );

String _compactCount(int value) {
  if (value >= 1000000) return '${(value / 1000000).toStringAsFixed(1)}M';
  if (value >= 1000) return '${(value / 1000).toStringAsFixed(1)}K';
  return '$value';
}

extension _SafeList<T> on List<T> {
  T? get firstOrNull => isEmpty ? null : first;
  T? elementAtOrNull(int index) =>
      index < 0 || index >= length ? null : this[index];
}
