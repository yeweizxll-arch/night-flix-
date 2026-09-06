import 'package:flutter/material.dart';
import 'package:video_player/video_player.dart';

import 'app_strings.dart';
import 'models.dart';

/// Keep the decoded frame's aspect ratio, including landscape films in a feed.
class PlayerSurface extends StatelessWidget {
  const PlayerSurface({super.key, required this.controller});
  final VideoPlayerController controller;

  @override
  Widget build(BuildContext context) => ColoredBox(
    color: Colors.black,
    child: Center(
      child: AspectRatio(
        aspectRatio: controller.value.aspectRatio,
        child: VideoPlayer(controller),
      ),
    ),
  );
}

class PlaybackControls extends StatefulWidget {
  const PlaybackControls({
    super.key,
    required this.controller,
    required this.toggle,
    required this.seek,
    this.canSeek = true,
  });
  final VideoPlayerController controller;
  final VoidCallback toggle;
  final ValueChanged<Duration> seek;
  final bool canSeek;

  @override
  State<PlaybackControls> createState() => _PlaybackControlsState();
}

class _PlaybackControlsState extends State<PlaybackControls> {
  double? dragPosition;

  String _time(Duration value) {
    final seconds = value.inSeconds;
    return '${seconds ~/ 60}:${(seconds % 60).toString().padLeft(2, '0')}';
  }

  @override
  Widget build(
    BuildContext context,
  ) => ValueListenableBuilder<VideoPlayerValue>(
    valueListenable: widget.controller,
    builder: (context, value, _) {
      final duration = value.duration.inMilliseconds.toDouble();
      return Row(
        children: [
          IconButton(
            key: const Key('playback-toggle'),
            tooltip: context.tr(
              value.isPlaying ? 'pause' : 'play',
              value.isPlaying ? 'Pause' : 'Play',
            ),
            onPressed: widget.toggle,
            color: Colors.white,
            icon: Icon(
              value.isPlaying ? Icons.pause_rounded : Icons.play_arrow_rounded,
            ),
          ),
          Text(
            _time(value.position),
            style: const TextStyle(fontSize: 11, color: Colors.white70),
          ),
          Expanded(
            child: SliderTheme(
              data: SliderTheme.of(context).copyWith(
                trackHeight: 2,
                thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 5),
                overlayShape: const RoundSliderOverlayShape(overlayRadius: 12),
              ),
              child: Slider(
                key: const Key('playback-seek'),
                min: 0,
                max: duration > 0 ? duration : 1,
                value:
                    (dragPosition ?? value.position.inMilliseconds.toDouble())
                        .clamp(0, duration > 0 ? duration : 1),
                onChanged: widget.canSeek && duration > 0
                    ? (position) => setState(() => dragPosition = position)
                    : null,
                onChangeEnd: widget.canSeek && duration > 0
                    ? (position) {
                        widget.seek(Duration(milliseconds: position.round()));
                        setState(() => dragPosition = null);
                      }
                    : null,
                activeColor: Colors.white,
                inactiveColor: Colors.white24,
              ),
            ),
          ),
          Text(
            _time(value.duration),
            style: const TextStyle(fontSize: 11, color: Colors.white70),
          ),
        ],
      );
    },
  );
}

class EpisodePicker extends StatefulWidget {
  const EpisodePicker({
    super.key,
    required this.drama,
    required this.currentId,
  });
  final Drama drama;
  final String? currentId;

  @override
  State<EpisodePicker> createState() => _EpisodePickerState();
}

class _EpisodePickerState extends State<EpisodePicker> {
  final scroll = ScrollController();
  bool descending = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _locate());
  }

  void _locate() {
    if (!mounted || !scroll.hasClients) return;
    final items = _episodes;
    final index = items.indexWhere((e) => e.id == widget.currentId);
    if (index < 0) return;
    final columns = ((MediaQuery.sizeOf(context).width - 40) / 62)
        .floor()
        .clamp(3, 8);
    scroll.jumpTo(
      ((index ~/ columns) * 64.0).clamp(0, scroll.position.maxScrollExtent),
    );
  }

  List<Episode> get _episodes {
    final sorted = [...widget.drama.episodes]
      ..sort((a, b) => a.number.compareTo(b.number));
    return descending ? sorted.reversed.toList() : sorted;
  }

  @override
  void dispose() {
    scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final items = _episodes;
    final accent = Theme.of(context).colorScheme.primary;
    return SafeArea(
      child: SizedBox(
        height: MediaQuery.sizeOf(context).height * .64,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 8, 8),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      widget.drama.title,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 20,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                  IconButton(
                    tooltip: MaterialLocalizations.of(context)
                        .closeButtonTooltip,
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(Icons.close),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      '${context.tr('episodes', 'Episodes')} · ${items.length}',
                      style: const TextStyle(color: Colors.white60),
                    ),
                  ),
                  TextButton.icon(
                    onPressed: () {
                      setState(() => descending = !descending);
                      WidgetsBinding.instance.addPostFrameCallback(
                        (_) => _locate(),
                      );
                    },
                    icon: const Icon(Icons.swap_vert, size: 18),
                    label: Text(
                      descending
                          ? '${items.lastOrNull?.number ?? 1} ← ${items.firstOrNull?.number ?? 1}'
                          : '${items.firstOrNull?.number ?? 1} → ${items.lastOrNull?.number ?? 1}',
                    ),
                  ),
                ],
              ),
            ),
            Expanded(
              child: LayoutBuilder(
                builder: (context, constraints) {
                  final columns = ((constraints.maxWidth - 40) / 62)
                      .floor()
                      .clamp(3, 8);
                  return GridView.builder(
                    controller: scroll,
                    padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
                    gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                      crossAxisCount: columns,
                      mainAxisExtent: 54,
                      mainAxisSpacing: 10,
                      crossAxisSpacing: 10,
                    ),
                    itemCount: items.length,
                    itemBuilder: (context, index) {
                      final item = items[index];
                      final selected = item.id == widget.currentId;
                      // A price alone does not prove a purchased episode is locked.
                      final locked = item.access == 'locked';
                      return Semantics(
                        selected: selected,
                        button: true,
                        label:
                            '${context.tr('episodes', 'Episodes')} ${item.number}',
                        child: Material(
                          key: ValueKey('episode-cell-${item.number}'),
                          color: selected
                              ? accent.withValues(alpha: .18)
                              : const Color(0xff292a32),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(8),
                            side: BorderSide(
                              color: selected ? accent : Colors.transparent,
                              width: 1.5,
                            ),
                          ),
                          child: InkWell(
                            borderRadius: BorderRadius.circular(8),
                            onTap: () => Navigator.pop(context, item),
                            child: Stack(
                              children: [
                                Center(
                                  child: Padding(
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 4,
                                    ),
                                    child: FittedBox(
                                      fit: BoxFit.scaleDown,
                                      child: Text(
                                        '${item.number}',
                                        maxLines: 1,
                                        softWrap: false,
                                        style: TextStyle(
                                          fontSize: 17,
                                          fontWeight: selected
                                              ? FontWeight.w800
                                              : FontWeight.w500,
                                          color: selected
                                              ? accent
                                              : Colors.white,
                                        ),
                                      ),
                                    ),
                                  ),
                                ),
                                if (selected)
                                  Positioned(
                                    right: 4,
                                    bottom: 3,
                                    child: Icon(
                                      Icons.equalizer,
                                      size: 11,
                                      color: accent,
                                    ),
                                  ),
                                if (locked && !selected)
                                  const Positioned(
                                    right: 4,
                                    top: 4,
                                    child: Icon(
                                      Icons.lock_outline,
                                      size: 11,
                                      color: Colors.white54,
                                    ),
                                  ),
                              ],
                            ),
                          ),
                        ),
                      );
                    },
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}
