using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace QuickPreview
{
    /// <summary>一个可用的新版本（来自 GitHub Releases 的最新正式版）。</summary>
    public sealed class UpdateInfo
    {
        /// <summary>规范化后的版本号，如 "1.9.0"。</summary>
        public string Version = "";
        /// <summary>原始 tag，如 "v1.9.0"。</summary>
        public string TagName = "";
        /// <summary>Release 标题，如 "v1.9.0 — 自动更新"。</summary>
        public string Name = "";
        /// <summary>Release 正文（Markdown）。</summary>
        public string Notes = "";
        public string HtmlUrl = "";
        public DateTime PublishedAtUtc = DateTime.MinValue;

        public string AssetName = "";
        public string AssetUrl = "";
        public long AssetSize;
        /// <summary>资产 sha256（小写十六进制）。GitHub 未提供 digest 时为空串。</summary>
        public string AssetSha256 = "";

        public bool HasAsset { get { return !string.IsNullOrEmpty(AssetUrl); } }
    }

    /// <summary>下载进度快照（约 200ms 上报一次）。</summary>
    public sealed class DownloadProgress
    {
        public long Received;
        public long Total;
        public double BytesPerSecond;
        public double Fraction { get { return Total > 0 ? Math.Min(1.0, (double)Received / Total) : 0; } }
    }

    /// <summary>检查更新的结果。失败也返回对象（不抛异常），便于 UI 统一展示。</summary>
    public sealed class UpdateCheckResult
    {
        public bool Ok;
        public string Message = "";
        public UpdateInfo Info;

        /// <summary>确实有比当前更新的版本，且带可下载的安装包。</summary>
        public bool NewerAvailable { get { return Ok && Info != null; } }
    }

    /// <summary>
    /// 自动更新：查 GitHub Releases 最新正式版 → 下载安装包 → 校验 → 静默安装 → 重启。
    ///
    /// 为什么不用第三方更新库（Squirrel / Velopack / AutoUpdater.NET）：
    ///   1) 本程序是自包含发布，体积大头是 .NET 运行时与 WebView2，这些库都假设自己那套
    ///      "版本目录 + 增量包"的布局，要改造发布产物与安装包；本项目只有 Inno 安装包这一种交付形态。
    ///   2) 它们普遍要求签名或专用 feed，而这里已经有 GitHub Releases（带 sha256 digest）可直接当 feed。
    ///   3) 真正难的不是"下载"，而是"静默覆盖正在运行的自身并重新拉起"——这一环由 Inno 的
    ///      taskkill + `runasoriginaluser` 承担，比另起一个 updater 进程更省事、也更不容易被安全软件拦。
    ///
    /// 安全边界（更新器一旦被劫持就是任意代码执行，这几条不能省）：
    ///   · 只走 HTTPS，且下载域名限定 github.com / *.githubusercontent.com；
    ///   · 大小必须与 API 声明一致，有 sha256 digest 就必须校验；
    ///   · 只运行本仓库最新正式版里的那个 .exe 资产。
    /// 测试用途：设置环境变量 QP_UPDATE_API 可把接口地址改成任意 URL（含本机 http），
    /// 会跳过域名白名单并记 WARN —— 仅用于离线回归，正常安装包里不会设置该变量。
    /// </summary>
    public static class UpdateService
    {
        public const string Owner = "mengyuefeitian";
        public const string Repo = "quickpreview";

        /// <summary>发布页（"查看发布页面"按钮、便携版无法静默更新时的兜底）。</summary>
        public const string ReleasesPage = "https://github.com/" + Owner + "/" + Repo + "/releases";

        private const string DefaultApi =
            "https://api.github.com/repos/" + Owner + "/" + Repo + "/releases/latest";

        /// <summary>安装后的固定位置（与 setup.iss 的 DefaultDirName 一致）。</summary>
        public static readonly string InstallDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Programs", "QuickPreview");

        /// <summary>下载落地目录（随 %LOCALAPPDATA%\QuickPreview 一起被卸载清理）。</summary>
        public static string UpdateDir { get { return Path.Combine(AppConfig.Dir, "updates"); } }

        private static string UserAgent
        {
            get { return "QuickPreview/" + AppVersion.Current + " (+" + ReleasesPage + ")"; }
        }

        /// <summary>测试钩子：QP_UPDATE_API 覆盖接口地址。</summary>
        public static string ApiUrl
        {
            get
            {
                try
                {
                    var o = Environment.GetEnvironmentVariable("QP_UPDATE_API");
                    if (!string.IsNullOrWhiteSpace(o)) return o.Trim();
                }
                catch { }
                return DefaultApi;
            }
        }

        public static bool TestMode
        {
            get
            {
                try { return !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("QP_UPDATE_API")); }
                catch { return false; }
            }
        }

        // ---------- 版本号 ----------

        /// <summary>把 "v1.9.0" / "1.9.0" / "1.9.0-beta.1" 规范成 "1.9.0"。</summary>
        public static string NormalizeVersion(string tag)
        {
            if (string.IsNullOrWhiteSpace(tag)) return "";
            var s = tag.Trim();
            if (s.StartsWith("v", StringComparison.OrdinalIgnoreCase)) s = s.Substring(1);
            int cut = s.IndexOfAny(new[] { '-', '+', ' ' });
            if (cut >= 0) s = s.Substring(0, cut);
            return s;
        }

        /// <summary>
        /// 逐段按数值比较（"1.10.0" 必须大于 "1.9.0"，字符串比较会得出相反结论）。
        /// 返回 &lt;0 / 0 / &gt;0，语义同 string.Compare。
        /// 段内的非数字尾巴（如 "0-beta"）不参与比较，调用方另行处理预发布标记。
        /// </summary>
        public static int CompareVersion(string a, string b)
        {
            var pa = SplitVersion(a);
            var pb = SplitVersion(b);
            int n = Math.Max(pa.Length, pb.Length);
            for (int i = 0; i < n; i++)
            {
                int va = i < pa.Length ? pa[i] : 0;
                int vb = i < pb.Length ? pb[i] : 0;
                if (va != vb) return va < vb ? -1 : 1;
            }
            return 0;
        }

        private static int[] SplitVersion(string v)
        {
            v = NormalizeVersion(v);
            if (v.Length == 0) return new int[0];
            var parts = v.Split('.');
            var nums = new int[parts.Length];
            for (int i = 0; i < parts.Length; i++)
            {
                int val = 0;
                int digits = 0;
                foreach (char c in parts[i])
                {
                    if (c < '0' || c > '9') break;
                    // 防御异常长的数字段（"999999999999"），超出 int 就当上限
                    if (val > 100000) { val = 100000; break; }
                    val = val * 10 + (c - '0');
                    digits++;
                }
                nums[i] = digits == 0 ? 0 : val;
            }
            return nums;
        }

        // ---------- 检查更新 ----------

        /// <summary>
        /// 查询最新正式版并与 currentVersion 比较。网络/解析失败返回 Ok=false + 中文原因，
        /// 绝不抛异常（后台自动检查时更不能弹窗）。
        /// </summary>
        public static async Task<UpdateCheckResult> CheckAsync(string currentVersion, CancellationToken ct)
        {
            var res = new UpdateCheckResult();
            if (TestMode)
                Log.W(LogKind.Update, "测试模式：接口地址被 QP_UPDATE_API 覆盖为 " + ApiUrl);

            try
            {
                string json;
                using (var http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) })
                {
                    http.DefaultRequestHeaders.UserAgent.ParseAdd(UserAgent);
                    http.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");

                    using (var resp = await http.GetAsync(ApiUrl, ct).ConfigureAwait(false))
                    {
                        if (resp.StatusCode == HttpStatusCode.NotFound)
                        {
                            res.Message = "仓库里还没有正式版本。";
                            Log.W(LogKind.Update, "检查更新：接口返回 404（无正式 Release）");
                            return res;
                        }
                        if (resp.StatusCode == (HttpStatusCode)403)
                        {
                            res.Message = "GitHub 接口访问受限（可能触发了频率限制），请稍后再试。";
                            Log.W(LogKind.Update, "检查更新：接口返回 403（可能是 rate limit）");
                            return res;
                        }
                        resp.EnsureSuccessStatusCode();
                        json = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
                    }
                }

                var info = ParseRelease(json, out string parseError);
                if (info == null)
                {
                    res.Message = parseError;
                    Log.W(LogKind.Update, "检查更新：解析失败 —— " + parseError);
                    return res;
                }

                Log.I(LogKind.Update, "检查更新：最新正式版 v" + info.Version
                    + "（当前 v" + AppVersion.Current + "），资产 " + info.AssetName
                    + "，" + info.AssetSize + " 字节");

                if (CompareVersion(info.Version, currentVersion) <= 0)
                {
                    res.Ok = true;
                    res.Message = "当前已是最新版本（v" + currentVersion + "）。";
                    return res;
                }

                if (!info.HasAsset)
                {
                    res.Ok = true;
                    res.Message = "发现新版本 v" + info.Version + "，但该版本没有可下载的安装包。";
                    Log.W(LogKind.Update, "检查更新：新版本缺少 .exe 资产，只能提示去发布页");
                    return res;
                }

                res.Ok = true;
                res.Info = info;
                return res;
            }
            catch (TaskCanceledException)
            {
                res.Message = "检查更新超时，请稍后再试。";
                Log.W(LogKind.Update, "检查更新超时（20s）");
            }
            catch (HttpRequestException ex)
            {
                res.Message = "无法连接 GitHub（请检查网络或代理）：" + Short(ex.Message);
                Log.W(LogKind.Update, "检查更新网络失败：" + ex.Message);
            }
            catch (Exception ex)
            {
                res.Message = "检查更新失败：" + Short(ex.Message);
                Log.W(LogKind.Update, "检查更新异常：" + ex.Message);
            }
            return res;
        }

        /// <summary>
        /// 解析 releases/latest 的 JSON。成功返回 null 之外的实例；失败返回 null 并给出原因。
        /// 公开是为了让离线回归（dev_update_test.py）能脱离网络直接断言字段解析。
        /// </summary>
        public static UpdateInfo ParseRelease(string json, out string error)
        {
            error = "";
            try
            {
                using (var doc = JsonDocument.Parse(json))
                {
                    var root = doc.RootElement;

                    if (GetBool(root, "draft") || GetBool(root, "prerelease"))
                    {
                        error = "最新一条 Release 是草稿或预发布版，暂不提供自动更新。";
                        return null;
                    }

                    var tag = GetString(root, "tag_name");
                    var version = NormalizeVersion(tag);
                    if (version.Length == 0)
                    {
                        error = "更新信息里没有版本号。";
                        return null;
                    }

                    var info = new UpdateInfo
                    {
                        Version = version,
                        TagName = tag,
                        Name = GetString(root, "name"),
                        Notes = GetString(root, "body"),
                        HtmlUrl = GetString(root, "html_url")
                    };

                    var pub = GetString(root, "published_at");
                    if (!string.IsNullOrEmpty(pub))
                    {
                        DateTime dt;
                        if (DateTime.TryParse(pub, CultureInfo.InvariantCulture,
                                DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out dt))
                            info.PublishedAtUtc = dt;
                    }

                    PickAsset(root, info);
                    return info;
                }
            }
            catch (JsonException ex)
            {
                error = "更新信息格式异常：" + Short(ex.Message);
                return null;
            }
        }

        /// <summary>从 assets 里挑安装包：优先名字带 Setup 的 .exe（x64 加一分）。</summary>
        private static void PickAsset(JsonElement root, UpdateInfo info)
        {
            JsonElement assets;
            if (!root.TryGetProperty("assets", out assets) || assets.ValueKind != JsonValueKind.Array)
                return;

            int bestScore = 0;
            foreach (var a in assets.EnumerateArray())
            {
                var name = GetString(a, "name");
                if (string.IsNullOrEmpty(name)) continue;
                if (!name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) continue;

                int score = 1;
                if (name.IndexOf("Setup", StringComparison.OrdinalIgnoreCase) >= 0) score += 2;
                if (name.IndexOf("x64", StringComparison.OrdinalIgnoreCase) >= 0) score += 1;
                if (score <= bestScore) continue;

                var url = GetString(a, "browser_download_url");
                if (!IsTrustedAssetUrl(url))
                {
                    Log.W(LogKind.Update, "跳过不可信的下载地址：" + url);
                    continue;
                }

                bestScore = score;
                info.AssetName = name;
                info.AssetUrl = url;
                info.AssetSize = GetLong(a, "size");
                info.AssetSha256 = ParseDigest(GetString(a, "digest"));
            }

            if (bestScore == 0)
            {
                info.AssetName = "";
                info.AssetUrl = "";
            }
        }

        /// <summary>GitHub 的 digest 形如 "sha256:abcdef..."，取十六进制部分。</summary>
        private static string ParseDigest(string digest)
        {
            if (string.IsNullOrWhiteSpace(digest)) return "";
            var s = digest.Trim();
            int colon = s.IndexOf(':');
            if (colon >= 0)
            {
                var algo = s.Substring(0, colon).Trim().ToLowerInvariant();
                if (algo != "sha256") return "";
                s = s.Substring(colon + 1);
            }
            s = s.Trim().ToLowerInvariant();
            foreach (char c in s)
                if (!Uri.IsHexDigit(c)) return "";
            return s.Length == 64 ? s : "";
        }

        /// <summary>只允许 GitHub 自家的 HTTPS 下载地址（测试模式下放开）。</summary>
        private static bool IsTrustedAssetUrl(string url)
        {
            if (string.IsNullOrWhiteSpace(url)) return false;

            if (TestMode)
            {
                Uri tu;
                if (Uri.TryCreate(url, UriKind.Absolute, out tu)
                    && (tu.Scheme == Uri.UriSchemeHttp || tu.Scheme == Uri.UriSchemeHttps))
                {
                    Log.W(LogKind.Update, "测试模式：放行下载地址 " + url);
                    return true;
                }
                return false;
            }

            Uri u;
            if (!Uri.TryCreate(url, UriKind.Absolute, out u)) return false;
            if (u.Scheme != Uri.UriSchemeHttps) return false;
            var host = u.Host.ToLowerInvariant();
            return host == "github.com"
                || host == "objects.githubusercontent.com"
                || host.EndsWith(".githubusercontent.com", StringComparison.Ordinal);
        }

        // ---------- 下载与校验 ----------

        /// <summary>
        /// 下载安装包到本地并校验（大小 + sha256）。返回落地路径。
        /// 先写 .part 再改名，中途失败/取消都不会留下一个"看起来完整"的文件。
        /// </summary>
        public static async Task<string> DownloadAsync(UpdateInfo info, IProgress<DownloadProgress> progress,
            CancellationToken ct)
        {
            if (info == null || !info.HasAsset) throw new InvalidOperationException("没有可下载的安装包。");
            if (!IsTrustedAssetUrl(info.AssetUrl)) throw new InvalidOperationException("下载地址不在允许的域名内。");

            Directory.CreateDirectory(UpdateDir);
            string fileName = Path.GetFileName(info.AssetName);
            if (string.IsNullOrEmpty(fileName)) fileName = "QuickPreview-Setup.exe";
            string final = Path.Combine(UpdateDir, fileName);
            string part = final + ".part";

            try { if (File.Exists(part)) File.Delete(part); } catch { }

            Log.I(LogKind.Update, "更新：开始下载 " + info.AssetUrl + "（预期 " + info.AssetSize + " 字节）");

            long received = 0;
            long total = info.AssetSize;
            string hash;

            using (var http = new HttpClient { Timeout = TimeSpan.FromMinutes(30) })
            {
                http.DefaultRequestHeaders.UserAgent.ParseAdd(UserAgent);
                using (var req = new HttpRequestMessage(HttpMethod.Get, info.AssetUrl))
                using (var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct)
                           .ConfigureAwait(false))
                {
                    resp.EnsureSuccessStatusCode();
                    if (resp.Content.Headers.ContentLength.HasValue && total <= 0)
                        total = resp.Content.Headers.ContentLength.Value;

                    using (var src = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false))
                    using (var sha = SHA256.Create())
                    using (var fs = new FileStream(part, FileMode.Create, FileAccess.Write, FileShare.None,
                               81920, useAsync: true))
                    {
                        var buf = new byte[81920];
                        var sw = Stopwatch.StartNew();
                        long lastReport = 0;
                        long lastBytes = 0;
                        double speed = 0;

                        while (true)
                        {
                            int n = await src.ReadAsync(buf, 0, buf.Length, ct).ConfigureAwait(false);
                            if (n <= 0) break;

                            await fs.WriteAsync(buf, 0, n, ct).ConfigureAwait(false);
                            sha.TransformBlock(buf, 0, n, null, 0);
                            received += n;

                            if (sw.ElapsedMilliseconds - lastReport >= 200)
                            {
                                double dt = (sw.ElapsedMilliseconds - lastReport) / 1000.0;
                                if (dt > 0) speed = (received - lastBytes) / dt;
                                lastReport = sw.ElapsedMilliseconds;
                                lastBytes = received;
                                if (progress != null)
                                    progress.Report(new DownloadProgress
                                    {
                                        Received = received,
                                        Total = total,
                                        BytesPerSecond = speed
                                    });
                            }
                        }

                        sha.TransformFinalBlock(Array.Empty<byte>(), 0, 0);
                        hash = ToHex(sha.Hash);
                    }
                }
            }

            if (progress != null)
                progress.Report(new DownloadProgress { Received = received, Total = total, BytesPerSecond = 0 });

            // 大小不对 = 被截断或拿到的是错误页，绝不能拿去安装
            if (total > 0 && received != total)
            {
                TryDelete(part);
                throw new InvalidDataException("下载不完整：收到 " + received + " 字节，应为 " + total + " 字节。");
            }

            if (!string.IsNullOrEmpty(info.AssetSha256))
            {
                if (!string.Equals(hash, info.AssetSha256, StringComparison.OrdinalIgnoreCase))
                {
                    TryDelete(part);
                    Log.E(LogKind.Update, "更新：校验失败，期望 " + info.AssetSha256 + "，实际 " + hash);
                    throw new InvalidDataException("安装包校验失败（SHA256 不匹配），已丢弃。");
                }
                Log.I(LogKind.Update, "更新：SHA256 校验通过 " + hash);
            }
            else
            {
                Log.W(LogKind.Update, "更新：该资产未提供 digest，仅按大小校验（" + received + " 字节）");
            }

            try
            {
                if (File.Exists(final)) File.Delete(final);
                File.Move(part, final);
            }
            catch (Exception ex)
            {
                TryDelete(part);
                throw new IOException("保存安装包失败：" + ex.Message);
            }

            Log.I(LogKind.Update, "更新：安装包已就绪 " + final + "（" + received + " 字节）");
            return final;
        }

        private static string ToHex(byte[] bytes)
        {
            if (bytes == null) return "";
            var sb = new System.Text.StringBuilder(bytes.Length * 2);
            foreach (var b in bytes) sb.Append(b.ToString("x2"));
            return sb.ToString();
        }

        private static void TryDelete(string path)
        {
            try { if (File.Exists(path)) File.Delete(path); } catch { }
        }

        /// <summary>清掉历史安装包，只留本次要用的那个（每个约 70MB，不清会一直堆）。</summary>
        public static void CleanupOldDownloads(string keepPath)
        {
            try
            {
                if (!Directory.Exists(UpdateDir)) return;
                foreach (var f in Directory.GetFiles(UpdateDir))
                {
                    if (keepPath != null && string.Equals(f, keepPath, StringComparison.OrdinalIgnoreCase))
                        continue;
                    try { File.Delete(f); } catch { }
                }
            }
            catch (Exception ex)
            {
                Log.W(LogKind.Update, "清理旧安装包失败：" + ex.Message);
            }
        }

        // ---------- 安装 ----------

        /// <summary>当前进程是否运行在"安装后的固定目录"里。</summary>
        public static bool IsInstalledCopy()
        {
            try
            {
                var cur = Path.GetFullPath(AppContext.BaseDirectory).TrimEnd('\\', '/');
                var ins = Path.GetFullPath(InstallDir).TrimEnd('\\', '/');
                return string.Equals(cur, ins, StringComparison.OrdinalIgnoreCase);
            }
            catch { return false; }
        }

        /// <summary>
        /// 启动安装程序并立即返回。参数含义：
        ///   /VERYSILENT /SUPPRESSMSGBOXES  静默，不弹任何向导与提示
        ///   /NORESTART                     绝不重启系统
        ///   /CLOSEAPPLICATIONS             若本程序还没退干净，由 Restart Manager 收尾
        ///   /relaunch=1                    自定义参数：装完自动把 QuickPreview 拉起来（见 setup.iss）
        /// 安装程序自己会在 InitializeSetup 里 taskkill 旧实例，所以这里不依赖"退出得够快"。
        /// </summary>
        public static void RunInstaller(string installerPath)
        {
            if (!File.Exists(installerPath))
                throw new FileNotFoundException("安装包不存在：" + installerPath);

            var psi = new ProcessStartInfo(installerPath)
            {
                Arguments = "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /relaunch=1",
                UseShellExecute = true,
                WorkingDirectory = Path.GetDirectoryName(installerPath) ?? AppConfig.Dir
            };

            Log.I(LogKind.Update, "更新：启动安装程序 " + installerPath + " " + psi.Arguments);
            var p = Process.Start(psi);
            Log.I(LogKind.Update, "更新：安装程序已启动（pid " + (p != null ? p.Id : 0) + "），本实例准备退出");
        }

        // ---------- 小工具 ----------

        private static string Short(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            s = s.Replace("\r", " ").Replace("\n", " ");
            return s.Length > 160 ? s.Substring(0, 160) + "…" : s;
        }

        private static string GetString(JsonElement e, string name)
        {
            JsonElement v;
            if (!e.TryGetProperty(name, out v) || v.ValueKind != JsonValueKind.String) return "";
            return v.GetString() ?? "";
        }

        private static bool GetBool(JsonElement e, string name)
        {
            JsonElement v;
            if (!e.TryGetProperty(name, out v)) return false;
            if (v.ValueKind == JsonValueKind.True) return true;
            if (v.ValueKind == JsonValueKind.False) return false;
            return false;
        }

        private static long GetLong(JsonElement e, string name)
        {
            JsonElement v;
            if (!e.TryGetProperty(name, out v)) return 0;
            if (v.ValueKind == JsonValueKind.Number)
            {
                long l;
                return v.TryGetInt64(out l) ? l : 0;
            }
            return 0;
        }
    }
}
