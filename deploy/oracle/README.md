# Deploy Cutline on Oracle Cloud (Always Free)

This sets up Cutline on an **Ampere A1 VM** (ARM64, Ubuntu 22.04/24.04) with a free HTTPS address, so you can open it from any phone or computer.

What `setup.sh` installs and configures:

| Piece | Details |
| --- | --- |
| Runtime | Node.js 22, pnpm, ffmpeg (with the `ass` caption filter), git, python3, yt-dlp |
| App | `/opt/cutline` (git checkout), runs as the `cutline` user under systemd, listens on `127.0.0.1:3000` only |
| Data | `/var/lib/cutline` (uploads, clips, database). Survives updates and reboots |
| Config | `/etc/cutline/cutline.env` (your Groq key lives here, readable by root and the app only) |
| Firewall | iptables rules for 80/443 saved with `netfilter-persistent` (Oracle's Ubuntu image blocks them by default) |
| HTTPS | Caddy reverse proxy on 80/443 with an automatic Let's Encrypt certificate; request body limit raised for 2048 MB uploads |

## 1. Create the VM (Oracle console)

1. Sign in at <https://cloud.oracle.com> (create an account first if needed; the Always Free tier needs a card for identity checks only). Pick your **home region** carefully, because it cannot be changed later and A1 capacity varies by region.
2. Open the menu → **Compute** → **Instances** → **Create instance**.
3. **Name:** `cutline`.
4. **Image and shape** → **Edit**:
   - **Change image** → **Ubuntu** → **Canonical Ubuntu 24.04** (the *aarch64* build) → **Select image**.
   - **Change shape** → **Ampere** → **VM.Standard.A1.Flex** → set **4 OCPUs** and **24 GB** memory (the whole Always Free allowance) → **Select shape**.
5. **Networking:** keep the default VCN and public subnet and make sure **Automatically assign public IPv4 address** is on.
6. **Add SSH keys:** choose **Paste public keys** (or **Upload public key file**). If you do not have a key yet, run this on your Windows laptop in PowerShell, then paste the output of the second command:
   ```powershell
   ssh-keygen -t ed25519
   type $env:USERPROFILE\.ssh\id_ed25519.pub
   ```
7. **Boot volume:** tick **Specify a custom boot volume size** and set **150 GB** (Always Free allows up to 200 GB in total). Clips and uploads take space.
8. Click **Create**. Wait until the instance shows **Running**, then copy its **Public IP address**.
   - If you see **"Out of capacity for shape VM.Standard.A1.Flex"**, try again later, or pick another **Availability domain** under *Placement*. This is common and not your fault.
9. *(Recommended)* Keep the IP permanently: **Networking** → **IP management** → **Reserved public IPs** → **Reserve public IP address**, then on the instance's **Attached VNICs** → **IPv4 addresses** → *Edit* → **Reserved public IP**. Always Free includes one reserved IP.

## 2. Open ports 80 and 443 in the VCN

1. **Networking** → **Virtual cloud networks** → click your VCN (named like `vcn-2026…`).
2. **Subnets** → click the **public subnet** → **Security** tab → click the **Default Security List**.
3. **Add Ingress Rules** (add each as its own rule):
   - **Source CIDR:** `0.0.0.0/0`, **IP Protocol:** TCP, **Destination Port Range:** `80`
   - **Source CIDR:** `0.0.0.0/0`, **IP Protocol:** TCP, **Destination Port Range:** `443`
4. Port 22 (SSH) is already open. The script handles the server's own firewall.

## 3. Install

From your laptop (replace the IP):

```bash
ssh ubuntu@<PUBLIC_IP>
```

On the server, run this one command. It asks for your **Groq API key** (hidden) and a **password** for the site login:

```bash
curl -fsSL https://raw.githubusercontent.com/roturohit1/clipper/feature/rohit-clipper/deploy/oracle/setup.sh -o /tmp/cutline-setup.sh && sudo bash /tmp/cutline-setup.sh --branch feature/rohit-clipper --auth-user rohit
```

It takes about 5-10 minutes. At the end it prints your address, for example `https://129-146-12-34.sslip.io`. The first visit can take up to a minute while the HTTPS certificate is issued.

### Options

| Option | Meaning |
| --- | --- |
| `--branch NAME` | Git branch to deploy (default `main`; the Cutline app is on `feature/rohit-clipper`) |
| `--domain example.com` | Use your own domain. Create an **A record** pointing at the VM's IP first. Without it the script uses `<ip-with-dashes>.sslip.io` |
| `--auth-user NAME` | Puts a username/password login in front of the whole site. **Strongly recommended**: Cutline has no login of its own, so without this anyone who finds the URL can use your Groq quota and your server |
| `--auth-pass PASS` | Give the password on the command line instead of being asked (it then stays in your shell history) |
| `GROQ_API_KEY=gsk_… ` | Set the key in the environment (`sudo GROQ_API_KEY=gsk_… bash …`) to skip the prompt |
| `INSTALL_LOCAL_WHISPER=1` | Also install free offline Whisper (slow on CPU; not needed with Groq) |

The script is safe to run again. It keeps your existing key, login and domain, and only changes what is missing.

## 4. Day to day

```bash
sudo bash /opt/cutline/deploy/oracle/update.sh          # pull, rebuild, restart (site is down ~1 min)
sudo bash /opt/cutline/deploy/oracle/update.sh main      # switch to another branch
journalctl -u cutline -f                                 # app log
sudo systemctl restart cutline                           # restart after editing /etc/cutline/cutline.env
sudo nano /etc/cutline/cutline.env                       # change key, models, MAX_CLIPS, MAX_UPLOAD_MB
sudo systemctl status cutline caddy
df -h /var/lib/cutline                                   # disk space used by clips
```

Environment variable names are the same as the app's `.env.example`. The script sets: `OPENAI_API_KEY` (your Groq key), `OPENAI_BASE_URL=https://api.groq.com/openai/v1`, `OPENAI_CHAT_MODEL=openai/gpt-oss-120b`, `OPENAI_TRANSCRIPTION_MODEL=whisper-large-v3-turbo`, `FFMPEG_PATH`, `FFPROBE_PATH`, `YTDLP_PATH`, `DATA_DIR=/var/lib/cutline`, `MAX_UPLOAD_MB=2048`.

If you raise `MAX_UPLOAD_MB`, run `sudo MAX_UPLOAD_MB=4096 bash /tmp/cutline-setup.sh --branch …` again so Caddy's body limit is updated too.

## Good to know

- **YouTube links from a datacenter:** YouTube often blocks cloud IP addresses ("Sign in to confirm you're not a bot"). Direct `.mp4` links and uploads always work. If YouTube links fail, upload the file instead.
- **sslip.io limits:** Let's Encrypt shares a weekly certificate quota across all `sslip.io` users. If HTTPS fails (`journalctl -u caddy`), use your own domain or a free DuckDNS name with `--domain`.
- **Cloudflare:** if your domain is on Cloudflare, set the record to **DNS only** (grey cloud). Their proxy limits uploads to 100 MB.
- **Idle reclaim:** Oracle can reclaim Always Free instances that stay almost idle for 7 days. Upgrading the account to Pay As You Go (still free within the Always Free limits) avoids that.
- **Processing speed:** with `JOB_CONCURRENCY=1` one video is processed at a time; encoding on 4 ARM cores is slower than on a laptop but fine for short clips.
- **Uninstall:** `sudo systemctl disable --now cutline caddy; sudo rm -rf /opt/cutline /etc/cutline /var/lib/cutline` (this deletes all clips).
