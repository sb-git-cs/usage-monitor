package io.github.sbgitcs.usagemonitor.ui

import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.ReaderException
import com.google.zxing.common.HybridBinarizer
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/** Camera preview that reports the text of every QR code it sees. The camera stops when this leaves the screen. */
@Composable
fun QrScanner(modifier: Modifier, onText: (String) -> Unit, onError: (String) -> Unit) {
    val owner = LocalLifecycleOwner.current
    val latestText by rememberUpdatedState(onText)
    val latestError by rememberUpdatedState(onError)
    val camera = remember { CameraHolder() }
    DisposableEffect(owner) {
        onDispose { camera.close() }
    }
    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            val view = PreviewView(ctx)
            val future = ProcessCameraProvider.getInstance(ctx)
            future.addListener({
                if (camera.closed) return@addListener
                try {
                    val provider = future.get()
                    val preview = Preview.Builder().build()
                    preview.setSurfaceProvider(view.surfaceProvider)
                    val analysis = ImageAnalysis.Builder()
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .build()
                    analysis.setAnalyzer(camera.executor, QrAnalyzer { text -> view.post { if (!camera.closed) latestText(text) } })
                    provider.unbindAll()
                    provider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                    camera.provider = provider
                } catch (e: Exception) {
                    latestError("The camera could not be started (${e.message}). Type the code instead.")
                }
            }, ContextCompat.getMainExecutor(ctx))
            view
        },
    )
}

private class CameraHolder {
    val executor: ExecutorService = Executors.newSingleThreadExecutor()
    var provider: ProcessCameraProvider? = null
    var closed = false

    fun close() {
        closed = true
        provider?.unbindAll()
        executor.shutdown()
    }
}

/** Reads QR codes from the camera's brightness plane with ZXing. */
private class QrAnalyzer(private val onText: (String) -> Unit) : ImageAnalysis.Analyzer {
    private val reader = MultiFormatReader().apply {
        setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE)))
    }

    override fun analyze(image: ImageProxy) {
        try {
            val plane = image.planes[0]
            val buffer = plane.buffer
            val bytes = ByteArray(buffer.remaining())
            buffer.get(bytes)
            val source = PlanarYUVLuminanceSource(bytes, plane.rowStride, image.height, 0, 0, image.width, image.height, false)
            val result = reader.decodeWithState(BinaryBitmap(HybridBinarizer(source)))
            onText(result.text)
        } catch (e: ReaderException) {
            // No QR code in this frame.
        } catch (e: RuntimeException) {
            // An odd frame; the next one will do.
        } finally {
            reader.reset()
            image.close()
        }
    }
}
