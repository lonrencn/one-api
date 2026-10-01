package controller

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/songquanpeng/one-api/common"
	"github.com/songquanpeng/one-api/common/ctxkey"
	"github.com/songquanpeng/one-api/model"
	"github.com/songquanpeng/one-api/relay/channeltype"
)

// RelayRerank 将 /v1/rerank 透传到上游重排端点:
//   - 智谱渠道: {base}/api/paas/v4/rerank (模型名应用渠道 model_mapping)
//   - 其他(OpenAI 兼容自定义渠道,如硅基流动): {base}/v1/rerank
//
// 计费: 成功响应带 usage.total_tokens 时按 1 token = 1 quota 记账。
func RelayRerank(c *gin.Context) {
	ctx := c.Request.Context()
	requestBody, err := common.GetRequestBody(c)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"message": err.Error(), "type": "one_api_error"}})
		return
	}

	modelName := c.GetString(ctxkey.RequestModel)
	if mapping := c.GetStringMapString(ctxkey.ModelMapping); mapping != nil {
		if upstream, ok := mapping[modelName]; ok && upstream != "" && upstream != modelName {
			var parsed map[string]any
			if json.Unmarshal(requestBody, &parsed) == nil && parsed["model"] != nil {
				parsed["model"] = upstream
				if bs, mErr := json.Marshal(parsed); mErr == nil {
					requestBody = bs
					modelName = upstream
				}
			}
		}
	}

	channelType := c.GetInt(ctxkey.Channel)
	baseURL := c.GetString(ctxkey.BaseURL)
	var requestURL string
	if channelType == channeltype.Zhipu {
		if baseURL == "" {
			baseURL = "https://open.bigmodel.cn"
		}
		requestURL = baseURL + "/api/paas/v4/rerank"
	} else {
		requestURL = baseURL + "/v1/rerank"
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, requestURL, bytes.NewReader(requestBody))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"message": err.Error(), "type": "one_api_error"}})
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", c.Request.Header.Get("Authorization"))
	req.Header.Set("Accept", "application/json")

	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": gin.H{"message": err.Error(), "type": "one_api_error"}})
		return
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if contentType := resp.Header.Get("Content-Type"); contentType != "" {
		c.Writer.Header().Set("Content-Type", contentType)
	}
	c.Writer.WriteHeader(resp.StatusCode)
	_, _ = c.Writer.Write(respBody)

	if resp.StatusCode == http.StatusOK && !strings.Contains(string(respBody), "\"error\"") {
		var payload struct {
			Usage *struct {
				TotalTokens int `json:"total_tokens"`
			} `json:"usage"`
		}
		if json.Unmarshal(respBody, &payload) == nil && payload.Usage != nil && payload.Usage.TotalTokens > 0 {
			quota := payload.Usage.TotalTokens
			_ = model.CacheDecreaseUserQuota(c.GetInt(ctxkey.Id), quota)
			_ = model.DecreaseTokenQuota(c.GetInt(ctxkey.TokenId), quota)
			model.RecordConsumeLog(context.Background(), &model.Log{
				UserId:       c.GetInt(ctxkey.Id),
				ChannelId:    c.GetInt(ctxkey.ChannelId),
				TokenName:    c.GetString(ctxkey.TokenName),
				ModelName:    modelName,
				PromptTokens: payload.Usage.TotalTokens,
				Quota:        quota,
				Content:      "rerank 透传计费",
			})
		}
	}
}
