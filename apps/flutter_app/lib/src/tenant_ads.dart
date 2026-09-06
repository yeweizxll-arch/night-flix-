import 'dart:async';
import 'dart:io';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:google_mobile_ads/google_mobile_ads.dart';

import 'drama_repository.dart';

final _tenantAds = Expando<TenantAds>();
TenantAds adsFor(AppController controller) =>
    _tenantAds[controller] ??= TenantAds(controller);

String? tenantAdUnit(
  Map<String, dynamic> config,
  String platform,
  String format,
) {
  if (config['enabled'] == false) return null;
  final nested = config[platform];
  final value = nested is Map
      ? nested[format]
      : config['$format${platform == 'ios' ? 'Ios' : 'Android'}'] ??
            (format == 'rewardedEpisode'
                ? config['rewardedEpisode'] ?? config['rewarded']
                : null);
  return value is String &&
          RegExp(r'^ca-app-pub-\d{16}/\d{10}$').hasMatch(value)
      ? value
      : null;
}

class AdFrequency {
  AdFrequency({DateTime Function()? now}) : now = now ?? DateTime.now;
  final DateTime Function() now;
  final Map<String, DateTime> _last = {};
  DateTime? _lastFullScreen;
  bool available(String format, Duration gap) =>
      (_last[format] == null || now().difference(_last[format]!) >= gap) &&
      (_lastFullScreen == null ||
          now().difference(_lastFullScreen!) >= const Duration(seconds: 30));
  void shown(String format) {
    _last[format] = now();
    _lastFullScreen = now();
  }
}

class TenantAds extends ChangeNotifier with WidgetsBindingObserver {
  TenantAds(this.controller);
  final AppController controller;
  final frequency = AdFrequency();
  bool ready = false;
  bool privacyRequired = false;
  int _consentRevision = 0;
  bool busy = false;
  bool _started = false;
  bool _disposed = false;
  bool _foreground = true;
  bool _loadingInterstitial = false;
  bool _loadingOpen = false;
  bool Function()? mayShowOpen;
  InterstitialAd? _interstitial;
  AppOpenAd? _open;
  DateTime? _openLoaded;
  DateTime? _interstitialLoaded;
  DateTime? _backgroundAt;
  VoidCallback? _finishActive;
  String? unit(String format) => tenantAdUnit(
    controller.config.admob,
    Platform.isIOS ? 'ios' : 'android',
    format,
  );

  Future<void> start() async {
    if (_started ||
        controller.repository.demoMode ||
        !controller.config.admobEnabled ||
        ![
          'rewardedEpisode',
          'interstitial',
          'appOpen',
          'native',
        ].any((format) => unit(format) != null)) {
      return;
    }
    _started = true;
    WidgetsBinding.instance.addObserver(this);
    try {
      final consent = Completer<void>();
      ConsentInformation.instance.requestConsentInfoUpdate(
        ConsentRequestParameters(),
        () {
          if (!consent.isCompleted) consent.complete();
        },
        (_) {
          if (!consent.isCompleted) consent.complete();
        },
      );
      await consent.future.timeout(const Duration(seconds: 10));
      if (_disposed) return;
      _busy(true);
      await ConsentForm.loadAndShowConsentFormIfRequired((_) {});
      privacyRequired =
          await ConsentInformation.instance
              .getPrivacyOptionsRequirementStatus() ==
          PrivacyOptionsRequirementStatus.required;
      _busy(false);
      if (_disposed || !await ConsentInformation.instance.canRequestAds()) {
        return;
      }
      await MobileAds.instance.initialize().timeout(
        const Duration(seconds: 10),
      );
      if (_disposed) return;
      ready = true;
      notifyListeners();
      _preload();
    } catch (_) {
      _busy(false);
    }
  }

  void _preload() {
    if (!ready || _disposed) return;
    final revision = _consentRevision;
    final interstitial = unit('interstitial');
    final open = unit('appOpen');
    if (interstitial != null &&
        _interstitial == null &&
        !_loadingInterstitial) {
      _loadingInterstitial = true;
      unawaited(
        InterstitialAd.load(
          adUnitId: interstitial,
          request: const AdRequest(nonPersonalizedAds: true),
          adLoadCallback: InterstitialAdLoadCallback(
            onAdLoaded: (ad) {
              _loadingInterstitial = false;
              if (_disposed || revision != _consentRevision) {
                ad.dispose();
                if (!_disposed && ready) _preload();
                return;
              }
              _interstitial = ad;
              _interstitialLoaded = DateTime.now();
            },
            onAdFailedToLoad: (_) => _loadingInterstitial = false,
          ),
        ).catchError((Object _) {
          _loadingInterstitial = false;
        }),
      );
    }
    if (open != null && _open == null && !_loadingOpen) {
      _loadingOpen = true;
      unawaited(
        AppOpenAd.load(
          adUnitId: open,
          request: const AdRequest(nonPersonalizedAds: true),
          adLoadCallback: AppOpenAdLoadCallback(
            onAdLoaded: (ad) {
              _loadingOpen = false;
              if (_disposed || revision != _consentRevision) {
                ad.dispose();
                if (!_disposed && ready) _preload();
                return;
              }
              _open = ad;
              _openLoaded = DateTime.now();
            },
            onAdFailedToLoad: (_) => _loadingOpen = false,
          ),
        ).catchError((Object _) {
          _loadingOpen = false;
        }),
      );
    }
  }

  Future<void> privacyOptions() async {
    if (_disposed || busy || !privacyRequired) return;
    _consentRevision++;
    ready = false;
    _interstitial?.dispose();
    _interstitial = null;
    _open?.dispose();
    _open = null;
    _busy(true);
    try {
      await ConsentForm.showPrivacyOptionsForm((_) {});
      ready = !_disposed && await ConsentInformation.instance.canRequestAds();
    } finally {
      _busy(false);
      _preload();
    }
  }

  Future<void> betweenEpisodes(
    bool Function() stillCurrent, {
    Map<String, String>? content,
  }) async {
    if (!ready ||
        busy ||
        !_foreground ||
        !stillCurrent() ||
        !frequency.available('interstitial', const Duration(minutes: 3))) {
      return;
    }
    final ad = _interstitial;
    _interstitial = null;
    if (ad == null) {
      _preload();
      return;
    }
    if (_interstitialLoaded == null ||
        DateTime.now().difference(_interstitialLoaded!) >
            const Duration(minutes: 50)) {
      await ad.dispose();
      _preload();
      return;
    }
    await _show(ad, 'interstitial', content: content);
    _preload();
  }

  Future<bool> rewarded(
    String adUnit,
    String challengeId,
    bool Function() stillCurrent, {
    Map<String, String>? content,
  }) async {
    if (!ready || busy || !_foreground || !stillCurrent()) return false;
    final configured = unit('rewardedEpisode');
    if (configured == null || configured != adUnit) return false;
    final loaded = Completer<RewardedAd?>();
    var expired = false;
    await RewardedAd.load(
      adUnitId: adUnit,
      request: const AdRequest(nonPersonalizedAds: true),
      rewardedAdLoadCallback: RewardedAdLoadCallback(
        onAdLoaded: (ad) {
          if (expired || _disposed || !stillCurrent()) {
            ad.dispose();
            if (!loaded.isCompleted) loaded.complete(null);
            return;
          }
          loaded.complete(ad);
        },
        onAdFailedToLoad: (_) {
          if (!loaded.isCompleted) loaded.complete(null);
        },
      ),
    );
    final ad = await loaded.future.timeout(
      const Duration(seconds: 12),
      onTimeout: () {
        expired = true;
        return null;
      },
    );
    if (ad == null) return false;
    try {
      await ad.setServerSideOptions(
        ServerSideVerificationOptions(customData: challengeId),
      );
      if (_disposed || busy || !_foreground || !stillCurrent()) {
        await ad.dispose();
        return false;
      }
      var earned = false;
      await _show(
        ad,
        'rewardedEpisode',
        reward: () => earned = true,
        content: content,
      );
      return earned;
    } catch (_) {
      await ad.dispose();
      return false;
    }
  }

  Future<void> _show(
    AdWithoutView ad,
    String format, {
    VoidCallback? reward,
    Map<String, String>? content,
  }) async {
    if (_disposed || busy) {
      await ad.dispose();
      return;
    }
    final closed = Completer<void>();
    void finish() {
      if (closed.isCompleted) return;
      ad.dispose();
      _finishActive = null;
      _busy(false);
      if (!closed.isCompleted) closed.complete();
    }

    FullScreenContentCallback<T> callback<T extends Ad>() =>
        FullScreenContentCallback<T>(
          onAdShowedFullScreenContent: (_) => frequency.shown(format),
          onAdDismissedFullScreenContent: (_) => finish(),
          onAdFailedToShowFullScreenContent: (_, _) => finish(),
        );
    _finishActive = finish;
    ad.onPaidEvent = revenueObserver(format, content);
    _busy(true);
    try {
      if (ad is RewardedAd) {
        ad.fullScreenContentCallback = callback<RewardedAd>();
        await ad.show(onUserEarnedReward: (_, _) => reward?.call());
      } else if (ad is InterstitialAd) {
        ad.fullScreenContentCallback = callback<InterstitialAd>();
        await ad.show();
      } else if (ad is AppOpenAd) {
        ad.fullScreenContentCallback = callback<AppOpenAd>();
        await ad.show();
      } else {
        finish();
      }
    } catch (_) {
      finish();
    }
    await closed.future;
  }

  OnPaidEventCallback revenueObserver(
    String format, [
    Map<String, String>? content,
  ]) {
    final eventId = List.generate(
      16,
      (_) => Random.secure().nextInt(256).toRadixString(16).padLeft(2, '0'),
    ).join();
    return (shown, micros, precision, currency) {
      if (_disposed ||
          !micros.isFinite ||
          micros < 0 ||
          micros > 9000000000000000 ||
          micros != micros.roundToDouble()) {
        return;
      }
      unawaited(
        controller.repository
            .adObservation({
              'eventId': eventId,
              'platform': Platform.isIOS ? 'ios' : 'android',
              'format': format,
              'adUnitId': shown.adUnitId,
              'currency': currency,
              'valueMicros': micros.toStringAsFixed(0),
              'precision': precision.name,
              ...?content,
            })
            .catchError((Object _) {}),
      );
    };
  }

  void _busy(bool value) {
    busy = value;
    if (!_disposed) notifyListeners();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    if (state == AppLifecycleState.paused) _backgroundAt = DateTime.now();
    if (!_foreground ||
        _disposed ||
        busy ||
        mayShowOpen?.call() != true ||
        _backgroundAt == null ||
        DateTime.now().difference(_backgroundAt!) <
            const Duration(seconds: 30) ||
        !frequency.available('appOpen', const Duration(minutes: 2))) {
      return;
    }
    final ad = _open;
    _open = null;
    _backgroundAt = null;
    if (ad == null) {
      _preload();
      return;
    }
    if (_openLoaded == null ||
        DateTime.now().difference(_openLoaded!) > const Duration(hours: 4)) {
      ad.dispose();
      _preload();
      return;
    }
    unawaited(_show(ad, 'appOpen').then((_) => _preload()));
  }

  @override
  void dispose() {
    _disposed = true;
    _finishActive?.call();
    _tenantAds[controller] = null;
    WidgetsBinding.instance.removeObserver(this);
    _interstitial?.dispose();
    _open?.dispose();
    super.dispose();
  }
}

class NativeAdPlacement extends StatefulWidget {
  const NativeAdPlacement({super.key, required this.controller});
  final AppController controller;
  @override
  State<NativeAdPlacement> createState() => _NativeAdPlacementState();
}

class _NativeAdPlacementState extends State<NativeAdPlacement> {
  NativeAd? ad;
  bool loaded = false;
  TenantAds get manager => adsFor(widget.controller);
  @override
  void initState() {
    super.initState();
    manager.addListener(_load);
    _load();
  }

  void _load() {
    if (mounted && !manager.ready && ad != null) {
      ad?.dispose();
      ad = null;
      setState(() => loaded = false);
    }
    if (!mounted || ad != null || !manager.ready) return;
    final id = manager.unit('native');
    if (id == null) return;
    ad = NativeAd(
      adUnitId: id,
      request: const AdRequest(nonPersonalizedAds: true),
      nativeTemplateStyle: NativeTemplateStyle(
        templateType: TemplateType.small,
      ),
      listener: NativeAdListener(
        onPaidEvent: manager.revenueObserver('native'),
        onAdLoaded: (received) {
          if (mounted && identical(ad, received) && manager.ready) {
            setState(() => loaded = true);
          } else {
            received.dispose();
          }
        },
        onAdFailedToLoad: (failed, _) {
          failed.dispose();
          if (mounted && identical(ad, failed)) setState(() => loaded = false);
        },
      ),
    );
    unawaited(ad!.load().catchError((Object _) {}));
  }

  @override
  void dispose() {
    manager.removeListener(_load);
    ad?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => !loaded || ad == null
      ? const SizedBox.shrink()
      : SizedBox(height: 120, child: AdWidget(ad: ad!));
}
