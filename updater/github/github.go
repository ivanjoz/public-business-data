// Package github is the publishing path: read what is committed, and write a new commit with
// several files at once. It talks to the Git Data API over plain HTTP instead of using a git
// client, because the provided.al2023 lambda image has no git binary and a read-only
// filesystem, and cloning a repository to write two kilobytes would be absurd.
package github

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"time"
)

const apiBase = "https://api.github.com"

// commitRetries covers the only race there is: the branch moving between reading the head and
// updating the ref. The update is never forced, so a lost race retries instead of overwriting.
const commitRetries = 3

type Client struct {
	Owner       string
	Repo        string
	Branch      string
	CommitName  string
	CommitEmail string

	token string
	http  *http.Client
}

func New(owner, repo, branch, commitName, commitEmail, token string) *Client {
	return &Client{
		Owner: owner, Repo: repo, Branch: branch,
		CommitName: commitName, CommitEmail: commitEmail,
		token: token,
		http:  &http.Client{Timeout: 30 * time.Second},
	}
}

// ReadFile returns the committed bytes of a path on the branch, or nil when it does not exist
// yet — which is what a brand new year looks like on the 1st of January.
//
// It reads from the API and not from the published site on purpose: GitHub Pages serves with
// Cache-Control: max-age=600, so a run landing inside that window would read a stale manifest,
// conclude the data changed and publish a commit with an identical tree.
func (c *Client) ReadFile(ctx context.Context, path string) ([]byte, error) {
	url := fmt.Sprintf("%s/repos/%s/%s/contents/%s?ref=%s", apiBase, c.Owner, c.Repo, path, c.Branch)

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	c.setHeaders(request)
	// The raw media type hands back the file bytes instead of a JSON envelope with base64.
	request.Header.Set("Accept", "application/vnd.github.raw")

	response, err := c.http.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()

	body, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, err
	}
	switch response.StatusCode {
	case http.StatusOK:
		return body, nil
	case http.StatusNotFound:
		return nil, nil
	default:
		return nil, fmt.Errorf("GET %s respondió %d: %s", path, response.StatusCode, body)
	}
}

// Commit writes every file in one commit. Partial publishes are the failure mode worth
// designing against here: a manifest that names a hash the .gz next to it does not have would
// make every client re-download that year forever.
func (c *Client) Commit(ctx context.Context, message string, files map[string][]byte) (string, error) {
	var lastErr error
	for attempt := range commitRetries {
		if attempt > 0 {
			select {
			case <-time.After(time.Duration(attempt) * time.Second):
			case <-ctx.Done():
				return "", ctx.Err()
			}
		}
		commitSha, err := c.commitOnce(ctx, message, files)
		if err == nil {
			return commitSha, nil
		}
		lastErr = err
	}
	return "", lastErr
}

func (c *Client) commitOnce(ctx context.Context, message string, files map[string][]byte) (string, error) {
	var head struct {
		Object struct {
			Sha string `json:"sha"`
		} `json:"object"`
	}
	if err := c.call(ctx, http.MethodGet, "/git/ref/heads/"+c.Branch, nil, &head); err != nil {
		return "", err
	}

	var baseCommit struct {
		Tree struct {
			Sha string `json:"sha"`
		} `json:"tree"`
	}
	if err := c.call(ctx, http.MethodGet, "/git/commits/"+head.Object.Sha, nil, &baseCommit); err != nil {
		return "", err
	}

	// base64 because the payloads are binary: the .gz would not survive a utf-8 round trip.
	type treeEntry struct {
		Path string `json:"path"`
		Mode string `json:"mode"`
		Type string `json:"type"`
		Sha  string `json:"sha"`
	}
	entries := make([]treeEntry, 0, len(files))

	for _, path := range sortedPaths(files) {
		var blob struct {
			Sha string `json:"sha"`
		}
		blobRequest := map[string]string{
			"content":  base64.StdEncoding.EncodeToString(files[path]),
			"encoding": "base64",
		}
		if err := c.call(ctx, http.MethodPost, "/git/blobs", blobRequest, &blob); err != nil {
			return "", err
		}
		entries = append(entries, treeEntry{Path: path, Mode: "100644", Type: "blob", Sha: blob.Sha})
	}

	var tree struct {
		Sha string `json:"sha"`
	}
	treeRequest := map[string]any{"base_tree": baseCommit.Tree.Sha, "tree": entries}
	if err := c.call(ctx, http.MethodPost, "/git/trees", treeRequest, &tree); err != nil {
		return "", err
	}

	var commit struct {
		Sha string `json:"sha"`
	}
	author := map[string]string{
		"name":  c.CommitName,
		"email": c.CommitEmail,
		"date":  time.Now().UTC().Format(time.RFC3339),
	}
	commitRequest := map[string]any{
		"message":   message,
		"tree":      tree.Sha,
		"parents":   []string{head.Object.Sha},
		"author":    author,
		"committer": author,
	}
	if err := c.call(ctx, http.MethodPost, "/git/commits", commitRequest, &commit); err != nil {
		return "", err
	}

	// No "force": if the branch moved since the head was read, this fails and Commit retries
	// the whole sequence rather than discarding whoever got there first.
	refRequest := map[string]any{"sha": commit.Sha, "force": false}
	if err := c.call(ctx, http.MethodPatch, "/git/refs/heads/"+c.Branch, refRequest, nil); err != nil {
		return "", err
	}
	return commit.Sha, nil
}

func (c *Client) call(ctx context.Context, method, path string, requestBody, responseTarget any) error {
	var body io.Reader
	if requestBody != nil {
		encoded, err := json.Marshal(requestBody)
		if err != nil {
			return err
		}
		body = bytes.NewReader(encoded)
	}

	url := fmt.Sprintf("%s/repos/%s/%s%s", apiBase, c.Owner, c.Repo, path)
	request, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return err
	}
	c.setHeaders(request)
	request.Header.Set("Accept", "application/vnd.github+json")
	if requestBody != nil {
		request.Header.Set("Content-Type", "application/json")
	}

	response, err := c.http.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()

	responseBody, err := io.ReadAll(response.Body)
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("%s %s respondió %d: %s", method, path, response.StatusCode, responseBody)
	}
	if responseTarget == nil {
		return nil
	}
	return json.Unmarshal(responseBody, responseTarget)
}

func (c *Client) setHeaders(request *http.Request) {
	// Sin token se va sin cabecera, no con una vacía: un "Bearer " a secas es una credencial
	// inválida y GitHub responde 401 en vez de tratarlo como lectura anónima de un repo público.
	if c.token != "" {
		request.Header.Set("Authorization", "Bearer "+c.token)
	}
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	request.Header.Set("User-Agent", "public-business-data-updater")
}

// sortedPaths keeps the blob order stable so a retry sends the same requests in the same order.
func sortedPaths(files map[string][]byte) []string {
	paths := make([]string, 0, len(files))
	for path := range files {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	return paths
}
