package middleware

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/chenyme/grok2api/backend/internal/infra/security"
	"github.com/gin-gonic/gin"
)

const RequestIDKey = "requestId"
const maxRequestIDLength = 64

// RequestID 为每个请求生成稳定关联 ID，并写入响应头。
func RequestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		requestID := strings.TrimSpace(c.GetHeader("X-Request-ID"))
		if !validRequestID(requestID) {
			requestID, _ = security.NewOpaqueToken(12)
			if requestID == "" {
				requestID = "req-" + strconv.FormatInt(time.Now().UnixNano(), 36)
			}
		}
		c.Set(RequestIDKey, requestID)
		c.Header("X-Request-ID", requestID)
		c.Next()
	}
}

// validRequestID 只接受适合写入日志和审计索引的短 ASCII 标识。
func validRequestID(value string) bool {
	if value == "" || len(value) > maxRequestIDLength {
		return false
	}
	for index := range len(value) {
		character := value[index]
		if (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9') {
			continue
		}
		switch character {
		case '-', '_', '.', ':':
		default:
			return false
		}
	}
	return true
}

// Timeout 为 HTTP 请求设置统一生命周期上限。
func Timeout(duration time.Duration) gin.HandlerFunc {
	return func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), duration)
		defer cancel()
		c.Request = c.Request.WithContext(ctx)
		c.Next()
	}
}

// MaxBodyBytes 对所有请求体应用统一硬上限，避免管理端绑定无界读取。
func MaxBodyBytes(limit int64) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.Body != nil && limit > 0 {
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, limit)
		}
		c.Next()
	}
}

// SecurityHeaders 为 API 和媒体响应添加通用浏览器安全边界。
func SecurityHeaders() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("X-Frame-Options", "DENY")
		c.Header("Referrer-Policy", "no-referrer")
		c.Header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		c.Next()
	}
}

// OpenAICORS 允许浏览器中的 OpenAI 兼容客户端调用公开 /v1 API。
// 管理端使用 Cookie 鉴权，不应用此中间件。
func OpenAICORS() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Access-Control-Allow-Origin", "*")
		c.Header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, X-API-Key, X-Request-ID, Anthropic-Version, Anthropic-Beta, OpenAI-Organization, OpenAI-Project")
		c.Header("Access-Control-Expose-Headers", "X-Request-ID, Content-Length, Content-Range, Accept-Ranges")
		c.Header("Access-Control-Max-Age", "600")
		c.Next()
	}
}

// AccessLog 只记录路径、状态和耗时，不读取请求或响应正文。
func AccessLog(logger *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		startedAt := time.Now()
		c.Next()
		requestID, _ := c.Get(RequestIDKey)
		logger.Info("http_request", "request_id", requestID, "method", c.Request.Method, "path", c.FullPath(), "status", c.Writer.Status(), "duration_ms", time.Since(startedAt).Milliseconds())
	}
}
