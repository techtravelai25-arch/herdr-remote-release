package dev.herdr.remote

import android.app.PendingIntent
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import androidx.core.graphics.createBitmap
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/** Native notification layouts retain Android's font scaling and lock-screen redaction. */
internal object NotificationPresentation {
    @Volatile private var cachedLogo: Bitmap? = null

    fun builder(context: Context, channel: String): NotificationCompat.Builder =
        NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_notification_herdr)
            .setColor(ContextCompat.getColor(context, R.color.notification_accent))

    fun alert(
        context: Context,
        channel: String,
        title: String,
        detail: String,
        open: PendingIntent,
        agent: String? = null,
    ): NotificationCompat.Builder = alertAppearance(context, channel, title, detail, agent)
        .setContentIntent(open)
        .addAction(0, "Open conversation", open)
        .setAutoCancel(true)

    /** Shared native appearance, renderable without system-owned intents in layoutlib. */
    fun alertAppearance(
        context: Context,
        channel: String,
        title: String,
        detail: String,
        agent: String? = null,
    ): NotificationCompat.Builder = builder(context, channel)
        .setContentTitle(title)
        .setContentText(detail)
        .setSubText(agent)
        .setStyle(NotificationCompat.BigTextStyle().bigText(detail))
        .setLargeIcon(logo(context))
        .setCategory(NotificationCompat.CATEGORY_MESSAGE)
        .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
        .setPublicVersion(builder(context, channel)
            .setContentTitle("Herdr Remote")
            .setContentText("Agent update. Unlock to view details.")
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build())

    private fun logo(context: Context): Bitmap? = cachedLogo ?: synchronized(this) {
        cachedLogo ?: run {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true; inScaled = false }
            BitmapFactory.decodeResource(context.resources, R.drawable.herdr_remote_logo, bounds)
            // Keep the notification parcel small even when the source artwork is high resolution.
            var sample = 1
            while (bounds.outWidth / sample > 256 || bounds.outHeight / sample > 256) sample *= 2
            BitmapFactory.decodeResource(context.resources, R.drawable.herdr_remote_logo,
                BitmapFactory.Options().apply { inSampleSize = sample; inScaled = false })
                ?.let { source ->
                    val tile = createBitmap(256, 256, Bitmap.Config.ARGB_8888)
                    val canvas = Canvas(tile)
                    val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
                    paint.color = ContextCompat.getColor(context, R.color.launcher_background)
                    canvas.drawRoundRect(0f, 0f, 256f, 256f, 56f, 56f, paint)
                    val scale = 224f / maxOf(source.width, source.height)
                    val width = source.width * scale
                    val height = source.height * scale
                    canvas.drawBitmap(source, null, RectF(
                        (256f - width) / 2, (256f - height) / 2,
                        (256f + width) / 2, (256f + height) / 2,
                    ), paint)
                    source.recycle()
                    tile
                }
                .also { cachedLogo = it }
        }
    }
}
