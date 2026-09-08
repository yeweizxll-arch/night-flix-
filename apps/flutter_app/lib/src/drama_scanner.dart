import 'package:flutter/material.dart';

import 'dart:io' show Platform;

import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';

import 'app_strings.dart';

/// OCR suggests editable search terms. It never claims to identify a film from a face/frame.
class DramaScanner extends StatefulWidget {
  const DramaScanner({super.key, required this.locale});
  final String locale;
  @override
  State<DramaScanner> createState() => _DramaScannerState();
}

class _DramaScannerState extends State<DramaScanner> {
  final query = TextEditingController();
  List<String> candidates = [];
  bool busy = false;
  String? error;
  @override
  void dispose() {
    query.dispose();
    super.dispose();
  }

  Future<void> _pick(ImageSource source) async {
    if (busy) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final picker = ImagePicker();
      final lost = Platform.isAndroid ? await picker.retrieveLostData() : null;
      final file =
          lost?.files?.firstOrNull ??
          await picker.pickImage(
            source: source,
            maxWidth: 2400,
            maxHeight: 2400,
          );
      if (file == null) return;
      final lines = await const MethodChannel('nightflix/text-recognition')
          .invokeListMethod<String>('recognize', {
            'path': file.path,
            'locale': widget.locale,
          })
          .timeout(const Duration(seconds: 30));
      if (!mounted) return;
      setState(() {
        candidates = (lines ?? [])
            .map((text) => text.trim())
            .where((text) => text.length >= 2 && text.length <= 100)
            .toSet()
            .toList();
      });
      if (candidates.isEmpty) {
        setState(
          () => error = context.isChinese ? '没有识别到剧名文字，请换一张清晰截图或手动输入。' : 'No title text found. Try a clearer screenshot or enter the title.',
        );
      }
    } catch (_) {
      if (mounted) {
        setState(
          () => error = context.isChinese ? '无法读取图片，请检查照片/相机权限后重试，也可以手动输入剧名。' : 'Unable to read image. Check photo/camera permission or type the title.',
        );
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: Text(context.isChinese ? '截图识剧' : 'Find title from screenshot'),
    ),
    body: ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Text(
          context.isChinese
              ? '识别截图中的文字，在站内搜索剧名。图片仅在本机处理，不上传；不支持无文字画面的人脸或剧情识别。'
              : 'Read title text from a screenshot, then search this catalog. Images stay on-device. This is text recognition, not face or scene identification.',
        ),
        const SizedBox(height: 16),
        Wrap(
          spacing: 12,
          children: [
            FilledButton.icon(
              onPressed: busy ? null : () => _pick(ImageSource.gallery),
              icon: const Icon(Icons.photo_library_outlined),
              label: Text(context.isChinese ? '选择截图' : 'Choose screenshot'),
            ),
            OutlinedButton.icon(
              onPressed: busy ? null : () => _pick(ImageSource.camera),
              icon: const Icon(Icons.camera_alt_outlined),
              label: Text(context.isChinese ? '拍照' : 'Camera'),
            ),
          ],
        ),
        if (busy) const LinearProgressIndicator(),
        if (error != null)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 12),
            child: Text(error!),
          ),
        TextField(
          controller: query,
          maxLength: 100,
          onChanged: (_) => setState(() {}),
          decoration: InputDecoration(
            labelText: context.tr('searchDramas', 'Search dramas'),
          ),
        ),
        FilledButton(
          onPressed: query.text.trim().isEmpty
              ? null
              : () => Navigator.pop(context, query.text.trim()),
          child: Text(context.tr('searchDramas', 'Search dramas')),
        ),
        for (final text in candidates)
          ListTile(
            title: Text(text),
            trailing: const Icon(Icons.north_west),
            onTap: () => setState(() => query.text = text),
          ),
      ],
    ),
  );
}
