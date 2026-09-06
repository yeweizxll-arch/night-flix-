package com.nightflix.template

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import android.net.Uri
import java.io.File
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import com.google.mlkit.vision.text.japanese.JapaneseTextRecognizerOptions
import com.google.mlkit.vision.text.korean.KoreanTextRecognizerOptions
import com.google.mlkit.vision.text.devanagari.DevanagariTextRecognizerOptions

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "nightflix/text-recognition")
            .setMethodCallHandler { call, result ->
                if (call.method != "recognize") { result.notImplemented(); return@setMethodCallHandler }
                try {
                    val file = File(call.argument<String>("path") ?: "").canonicalFile
                    // Flutter's Directory.systemTemp uses code_cache on Android;
                    // image_picker uses cache. Both are private app directories.
                    val cached = listOf(cacheDir, codeCacheDir).any {
                        file.path.startsWith(it.canonicalPath + File.separator)
                    }
                    require(cached
                        && file.isFile && file.length() <= 20L * 1024 * 1024) { "Invalid image" }
                    val image = InputImage.fromFilePath(this, Uri.fromFile(file))
                    val recognizer = when (call.argument<String>("locale")?.substringBefore('-')) {
                        "ja" -> TextRecognition.getClient(JapaneseTextRecognizerOptions.Builder().build())
                        "ko" -> TextRecognition.getClient(KoreanTextRecognizerOptions.Builder().build())
                        "hi" -> TextRecognition.getClient(DevanagariTextRecognizerOptions.Builder().build())
                        else -> TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build())
                    }
                    recognizer.process(image)
                        .addOnSuccessListener { text -> result.success(text.textBlocks.flatMap { block -> block.lines.map { it.text } }.take(100)) }
                        .addOnFailureListener { result.error("RECOGNITION_FAILED", "Could not read image text", null) }
                        .addOnCompleteListener { recognizer.close() }
                } catch (_: Exception) {
                    result.error("INVALID_IMAGE", "Could not open image", null)
                }
            }
    }
}
