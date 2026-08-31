import 'package:flutter/material.dart';
import 'package:in_app_purchase/in_app_purchase.dart';
import 'package:video_player/video_player.dart';

import 'drama_repository.dart';
import 'models.dart';

const _ink = Color(0xff080911);
const _purple = Color(0xff7558ff);
const _pink = Color(0xffff4d8d);

class DramaApp extends StatelessWidget {
  const DramaApp({super.key, required this.controller});
  final AppController controller;

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: controller.config.siteName,
    debugShowCheckedModeBanner: false,
    theme: ThemeData(
      brightness: Brightness.dark,
      scaffoldBackgroundColor: _ink,
      colorScheme: const ColorScheme.dark(
        primary: _purple,
        secondary: _pink,
        surface: Color(0xff141622),
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
    home: ListenableBuilder(
      listenable: controller,
      builder: (context, _) => controller.loading && controller.dramas.isEmpty
          ? const _LaunchScreen()
          : controller.error != null && controller.dramas.isEmpty
          ? _ErrorScreen(message: controller.error!, retry: controller.retry)
          : AppShell(controller: controller),
    ),
  );
}

class AppShell extends StatefulWidget {
  const AppShell({super.key, required this.controller});
  final AppController controller;
  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  int index = 0;

  @override
  Widget build(BuildContext context) {
    final pages = [
      FeedScreen(controller: widget.controller),
      TheaterScreen(controller: widget.controller),
      RewardsScreen(controller: widget.controller),
      LibraryScreen(controller: widget.controller),
      ProfileScreen(controller: widget.controller),
    ];
    return Scaffold(
      extendBody: index == 0,
      body: IndexedStack(index: index, children: pages),
      bottomNavigationBar: NavigationBar(
        selectedIndex: index,
        onDestinationSelected: (value) => setState(() => index = value),
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.smart_display_outlined),
            selectedIcon: Icon(Icons.smart_display),
            label: 'For You',
          ),
          NavigationDestination(
            icon: Icon(Icons.local_movies_outlined),
            selectedIcon: Icon(Icons.local_movies),
            label: 'Drama',
          ),
          NavigationDestination(
            icon: Icon(Icons.card_giftcard_outlined),
            selectedIcon: Icon(Icons.card_giftcard),
            label: 'Rewards',
          ),
          NavigationDestination(
            icon: Icon(Icons.bookmark_border),
            selectedIcon: Icon(Icons.bookmark),
            label: 'Library',
          ),
          NavigationDestination(
            icon: Icon(Icons.person_outline),
            selectedIcon: Icon(Icons.person),
            label: 'Me',
          ),
        ],
      ),
    );
  }
}

class FeedScreen extends StatefulWidget {
  const FeedScreen({super.key, required this.controller});
  final AppController controller;
  @override
  State<FeedScreen> createState() => _FeedScreenState();
}

class _FeedScreenState extends State<FeedScreen> {
  int current = 0;

  @override
  Widget build(BuildContext context) {
    if (widget.controller.dramas.isEmpty) {
      return const Center(child: Text('No dramas yet'));
    }
    return PageView.builder(
      scrollDirection: Axis.vertical,
      itemCount: widget.controller.dramas.length,
      onPageChanged: (value) {
        setState(() => current = value);
        widget.controller.markWatched(widget.controller.dramas[value].id);
      },
      itemBuilder: (context, index) => DramaPage(
        key: ValueKey(widget.controller.dramas[index].id),
        active: current == index,
        controller: widget.controller,
        drama: widget.controller.dramas[index],
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
  });
  final bool active;
  final AppController controller;
  final Drama drama;
  @override
  State<DramaPage> createState() => _DramaPageState();
}

class _DramaPageState extends State<DramaPage> {
  Drama? detail;
  Episode? episode;
  VideoPlayerController? video;
  bool loading = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(covariant DramaPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.active && !oldWidget.active) _play();
    if (!widget.active && oldWidget.active) video?.pause();
  }

  Future<void> _load() async {
    setState(() => loading = true);
    try {
      final loaded = await widget.controller.loadDetail(widget.drama);
      if (!mounted) return;
      detail = loaded;
      episode = loaded.episodes.firstOrNull;
      if (widget.active) await _play();
    } catch (_) {
      // Catalog copy remains useful when a detail request temporarily fails.
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  Future<void> _play() async {
    final selected = episode;
    if (selected == null || widget.controller.session == null) return;
    try {
      final playable = await widget.controller.loadPlayback(selected);
      if (!mounted || playable.playbackUrl == null) return;
      episode = playable;
      await video?.dispose();
      final next = VideoPlayerController.networkUrl(
        Uri.parse(playable.playbackUrl!),
      );
      video = next;
      await next.initialize();
      await next.setLooping(false);
      await next.play();
      if (mounted) setState(() {});
    } catch (_) {
      if (mounted) setState(() {});
    }
  }

  @override
  void dispose() {
    video?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final drama = detail ?? widget.drama;
    return Stack(
      fit: StackFit.expand,
      children: [
        _Backdrop(palette: drama.palette),
        if (video?.value.isInitialized == true)
          FittedBox(
            fit: BoxFit.cover,
            child: SizedBox(
              width: video!.value.size.width,
              height: video!.value.size.height,
              child: VideoPlayer(video!),
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
        SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(18, 8, 12, 90),
            child: Column(
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    _feedTab('Following', false),
                    const SizedBox(width: 22),
                    _feedTab('For You', true),
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
                          Text(
                            drama.title,
                            style: const TextStyle(
                              fontSize: 24,
                              fontWeight: FontWeight.w800,
                            ),
                          ),
                          const SizedBox(height: 8),
                          Text(
                            'EP ${episode?.number ?? 1}  ·  ${drama.totalEpisodes} episodes',
                            style: const TextStyle(
                              fontSize: 13,
                              color: Colors.white70,
                            ),
                          ),
                          const SizedBox(height: 9),
                          Text(
                            drama.summary,
                            maxLines: 3,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontSize: 14, height: 1.35),
                          ),
                          const SizedBox(height: 12),
                          FilledButton.tonalIcon(
                            onPressed: () => _showEpisodes(context, drama),
                            icon: const Icon(Icons.grid_view_rounded, size: 18),
                            label: const Text('Episodes'),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 12),
                    Column(
                      children: [
                        _action(
                          Icons.favorite_border,
                          '12.8K',
                          () => _requireLogin(context, 'Like'),
                        ),
                        _action(
                          widget.controller.favorites.contains(drama.id)
                              ? Icons.bookmark
                              : Icons.bookmark_border,
                          'Save',
                          () async {
                            if (!await _requireLogin(context, 'Save')) return;
                            await widget.controller.toggleFavorite(drama.id);
                          },
                        ),
                        _action(
                          Icons.chat_bubble_outline,
                          '428',
                          () => _requireLogin(context, 'Comment'),
                        ),
                        _action(
                          Icons.share_outlined,
                          'Share',
                          () => _message(context, 'Deep link copied'),
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
        if (episode?.locked == true)
          Center(
            child: _UnlockCard(
              points: episode?.pointsAmount ?? drama.pointsAmount ?? 0,
              unlock: () async {
                final authenticated = await _requireLogin(context, 'Unlock');
                if (!context.mounted) return;
                if (authenticated) {
                  _message(context, 'Purchase options loaded');
                }
              },
            ),
          ),
        if (widget.controller.session == null &&
            !widget.controller.repository.demoMode)
          Center(
            child: FilledButton.icon(
              onPressed: () async {
                if (await _showLogin(context, widget.controller)) _play();
              },
              icon: const Icon(Icons.play_arrow),
              label: const Text('Sign in to watch'),
            ),
          ),
      ],
    );
  }

  Future<bool> _requireLogin(BuildContext context, String action) async {
    if (widget.controller.session != null) return true;
    return _showLogin(
      context,
      widget.controller,
      reason: '$action requires an account',
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
                  '${drama.title} · Episodes',
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
                          video?.dispose();
                          video = null;
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

class TheaterScreen extends StatelessWidget {
  const TheaterScreen({super.key, required this.controller});
  final AppController controller;

  @override
  Widget build(BuildContext context) => SafeArea(
    child: CustomScrollView(
      slivers: [
        SliverAppBar.large(
          title: const Text('Drama Theater'),
          backgroundColor: _ink,
        ),
        SliverToBoxAdapter(
          child: SizedBox(
            height: 48,
            child: ListView(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              scrollDirection: Axis.horizontal,
              children:
                  ['Trending', 'Romance', 'Revenge', 'Billionaire', 'Fantasy']
                      .map(
                        (label) => Padding(
                          padding: const EdgeInsets.only(right: 8),
                          child: FilterChip(
                            label: Text(label),
                            selected: label == 'Trending',
                            onSelected: (_) {},
                          ),
                        ),
                      )
                      .toList(),
            ),
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
            itemCount: controller.dramas.length,
            itemBuilder: (context, index) {
              final drama = controller.dramas[index];
              return Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(16),
                      child: _Backdrop(palette: drama.palette),
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
                    '${drama.totalEpisodes} episodes',
                    style: const TextStyle(color: Colors.white54, fontSize: 12),
                  ),
                ],
              );
            },
          ),
        ),
      ],
    ),
  );
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
        const Text(
          'Rewards',
          style: TextStyle(fontSize: 32, fontWeight: FontWeight.w800),
        ),
        const SizedBox(height: 18),
        Container(
          padding: const EdgeInsets.all(22),
          decoration: BoxDecoration(
            gradient: const LinearGradient(colors: [_purple, _pink]),
            borderRadius: BorderRadius.circular(22),
          ),
          child: const Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Daily bonus',
                style: TextStyle(fontSize: 14, color: Colors.white70),
              ),
              SizedBox(height: 4),
              Text(
                'Watch and earn coins',
                style: TextStyle(fontSize: 24, fontWeight: FontWeight.w800),
              ),
            ],
          ),
        ),
        const SizedBox(height: 26),
        _rewardTile(
          Icons.play_circle_fill,
          'Watch a rewarded video',
          '+5 coins',
          () => _message(context, 'Rewarded ad placement requested'),
        ),
        _rewardTile(
          Icons.calendar_month,
          'Daily check-in',
          '+2 coins',
          () => _message(context, 'Checked in'),
        ),
        _rewardTile(
          Icons.person_add_alt_1,
          'Invite a friend',
          '+20 coins',
          () => _message(context, 'Invite link copied'),
        ),
        const SizedBox(height: 24),
        FilledButton(
          onPressed: () => _openStore(context),
          child: const Text('Get more coins'),
        ),
      ],
    ),
  );

  Future<void> _openStore(BuildContext context) async {
    if (widget.controller.session == null &&
        !await _showLogin(
          context,
          widget.controller,
          reason: 'Purchases require an account',
        )) {
      return;
    }
    if (!context.mounted) return;
    final ids = widget.controller.config.storeProducts.values
        .whereType<String>()
        .toSet();
    if (ids.isEmpty) {
      _message(context, 'Store products are not configured for this tenant');
      return;
    }
    final response = await InAppPurchase.instance.queryProductDetails(ids);
    if (!context.mounted) return;
    showModalBottomSheet<void>(
      context: context,
      builder: (context) => ListView(
        padding: const EdgeInsets.all(20),
        children: [
          const Text(
            'Coin Store',
            style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold),
          ),
          ...response.productDetails.map(
            (product) => ListTile(
              title: Text(product.title),
              subtitle: Text(product.description),
              trailing: Text(product.price),
              onTap: () => InAppPurchase.instance.buyConsumable(
                purchaseParam: PurchaseParam(productDetails: product),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class LibraryScreen extends StatelessWidget {
  const LibraryScreen({super.key, required this.controller});
  final AppController controller;

  @override
  Widget build(BuildContext context) {
    final saved = controller.dramas
        .where((drama) => controller.favorites.contains(drama.id))
        .toList();
    final watched = controller.history
        .map(
          (id) => controller.dramas.where((item) => item.id == id).firstOrNull,
        )
        .whereType<Drama>()
        .toList();
    return SafeArea(
      child: DefaultTabController(
        length: 2,
        child: Column(
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 20, 20, 8),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  'My Library',
                  style: TextStyle(fontSize: 30, fontWeight: FontWeight.w800),
                ),
              ),
            ),
            const TabBar(
              tabs: [
                Tab(text: 'Watch History'),
                Tab(text: 'Favorites'),
              ],
            ),
            Expanded(
              child: TabBarView(
                children: [
                  _DramaList(items: watched),
                  _DramaList(items: saved),
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
                    controller.session?.email ?? 'Guest',
                    style: const TextStyle(
                      fontSize: 22,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  Text(
                    controller.session == null
                        ? 'Sign in to sync purchases and history'
                        : 'Account connected',
                    style: const TextStyle(color: Colors.white60),
                  ),
                ],
              ),
            ),
            if (controller.session == null)
              FilledButton(
                onPressed: () => _showLogin(context, controller),
                child: const Text('Sign in'),
              ),
          ],
        ),
        const SizedBox(height: 26),
        _profileTile(
          Icons.workspace_premium_outlined,
          'Membership',
          'Plans and benefits',
        ),
        _profileTile(
          Icons.monetization_on_outlined,
          'Coins',
          'Balance and transactions',
        ),
        _profileTile(
          Icons.notifications_none,
          'Messages',
          'Updates and replies',
        ),
        _profileTile(
          Icons.language,
          'Language',
          controller.locale,
          onTap: () => _languageSheet(context, controller),
        ),
        _profileTile(
          Icons.settings_outlined,
          'Settings',
          'Playback, subtitles and privacy',
        ),
        _profileTile(Icons.help_outline, 'Help & support', 'FAQ and contact'),
        if (controller.session != null)
          Padding(
            padding: const EdgeInsets.only(top: 18),
            child: OutlinedButton(
              onPressed: controller.logout,
              child: const Text('Sign out'),
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
  String get searchFieldLabel => 'Search dramas';
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
  Widget _results() {
    final lowered = query.toLowerCase();
    return _DramaList(
      items: controller.dramas
          .where(
            (drama) =>
                drama.title.toLowerCase().contains(lowered) ||
                drama.summary.toLowerCase().contains(lowered),
          )
          .toList(),
    );
  }
}

class _DramaList extends StatelessWidget {
  const _DramaList({required this.items});
  final List<Drama> items;
  @override
  Widget build(BuildContext context) => items.isEmpty
      ? const Center(
          child: Text(
            'Nothing here yet',
            style: TextStyle(color: Colors.white54),
          ),
        )
      : ListView.separated(
          padding: const EdgeInsets.all(16),
          itemCount: items.length,
          separatorBuilder: (_, _) => const SizedBox(height: 12),
          itemBuilder: (context, index) {
            final drama = items[index];
            return Row(
              children: [
                SizedBox(
                  width: 82,
                  height: 112,
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(12),
                    child: _Backdrop(palette: drama.palette),
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
                        '${drama.totalEpisodes} episodes',
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
            );
          },
        );
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
  const _UnlockCard({required this.points, required this.unlock});
  final int points;
  final VoidCallback unlock;
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
        const Text(
          'Continue watching',
          style: TextStyle(fontSize: 19, fontWeight: FontWeight.bold),
        ),
        const SizedBox(height: 6),
        Text(
          points > 0
              ? 'Unlock this episode for $points coins'
              : 'Choose an unlock option',
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 16),
        SizedBox(
          width: double.infinity,
          child: FilledButton(onPressed: unlock, child: const Text('Unlock')),
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
            'SHANCHUANG',
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
            FilledButton(onPressed: retry, child: const Text('Try again')),
          ],
        ),
      ),
    ),
  );
}

Widget _feedTab(String label, bool selected) => Column(
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

Widget _rewardTile(
  IconData icon,
  String title,
  String subtitle,
  VoidCallback action,
) => Card(
  child: ListTile(
    leading: CircleAvatar(
      backgroundColor: const Color(0x337558ff),
      child: Icon(icon, color: _purple),
    ),
    title: Text(title),
    subtitle: Text(subtitle),
    trailing: FilledButton.tonal(onPressed: action, child: const Text('Claim')),
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
}) async {
  final email = TextEditingController();
  final password = TextEditingController();
  String? error;
  final result = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (context) => StatefulBuilder(
      builder: (context, setState) => Padding(
        padding: EdgeInsets.fromLTRB(
          22,
          12,
          22,
          MediaQuery.viewInsetsOf(context).bottom + 24,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              reason ?? 'Welcome back',
              style: const TextStyle(fontSize: 23, fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 8),
            const Text(
              'Your purchases, favorites and history stay with you.',
              style: TextStyle(color: Colors.white60),
            ),
            const SizedBox(height: 18),
            TextField(
              controller: email,
              keyboardType: TextInputType.emailAddress,
              decoration: const InputDecoration(labelText: 'Email'),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: password,
              obscureText: true,
              decoration: const InputDecoration(labelText: 'Password'),
            ),
            if (error != null)
              Padding(
                padding: const EdgeInsets.only(top: 10),
                child: Text(
                  error!,
                  style: const TextStyle(color: Colors.redAccent),
                ),
              ),
            const SizedBox(height: 16),
            FilledButton(
              onPressed: () async {
                try {
                  await controller.login(email.text, password.text);
                  if (context.mounted) Navigator.pop(context, true);
                } catch (cause) {
                  setState(() => error = cause.toString());
                }
              },
              child: const Text('Continue with email'),
            ),
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 14),
              child: Row(
                children: [
                  Expanded(child: Divider()),
                  Padding(
                    padding: EdgeInsets.symmetric(horizontal: 12),
                    child: Text('or'),
                  ),
                  Expanded(child: Divider()),
                ],
              ),
            ),
            OutlinedButton.icon(
              onPressed: () => _message(
                context,
                'Google login needs this agent\'s OAuth client ID',
              ),
              icon: const Icon(Icons.g_mobiledata),
              label: const Text('Continue with Google'),
            ),
            OutlinedButton.icon(
              onPressed: () => _message(
                context,
                'Apple login needs this agent\'s Services ID',
              ),
              icon: const Icon(Icons.apple),
              label: const Text('Continue with Apple'),
            ),
          ],
        ),
      ),
    ),
  );
  email.dispose();
  password.dispose();
  return result == true;
}

void _languageSheet(BuildContext context, AppController controller) =>
    showModalBottomSheet<void>(
      context: context,
      builder: (context) => ListView(
        shrinkWrap: true,
        padding: const EdgeInsets.all(20),
        children: [
          const Text(
            'Language',
            style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold),
          ),
          ...controller.config.supportedLocales.map(
            (locale) => ListTile(
              selected: locale == controller.locale,
              title: Text(locale),
              trailing: locale == controller.locale
                  ? const Icon(Icons.check, color: _purple)
                  : null,
              onTap: () {
                controller.setLocale(locale);
                Navigator.pop(context);
              },
            ),
          ),
        ],
      ),
    );

void _message(BuildContext context, String value) =>
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(value), behavior: SnackBarBehavior.floating),
    );

extension _SafeList<T> on List<T> {
  T? get firstOrNull => isEmpty ? null : first;
  T? elementAtOrNull(int index) =>
      index < 0 || index >= length ? null : this[index];
}
