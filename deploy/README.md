# Deploying

Two paths. Start with the first one.

## 1. One cheap instance (recommended to start)

A single AWS Lightsail instance at roughly $10/month will comfortably carry
your first few thousand players, because the world is generated rather than
stored and SQLite is running on the same box. There are no fixed costs for a
load balancer, a managed database, or a cache.

Create a Lightsail instance (Ubuntu 24.04, the $10 tier — the $5 tier's 512 MB
is tight once the dictionary is loaded), then:

```bash
# On the instance
sudo apt update && sudo apt install -y nginx git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

sudo mkdir -p /srv/wordworld /var/lib/wordworld
sudo chown -R $USER /srv/wordworld /var/lib/wordworld
git clone YOUR_REPO_URL /srv/wordworld
cd /srv/wordworld && npm install --omit=dev
```

Generate a world seed and keep it somewhere safe:

```bash
openssl rand -hex 32
```

Install the service and reverse proxy from this directory:

```bash
sudo cp deploy/wordworld.service /etc/systemd/system/
sudo systemctl edit wordworld   # paste your WORLD_SEED here
sudo systemctl enable --now wordworld

sudo cp deploy/nginx.conf /etc/nginx/sites-available/wordworld
sudo ln -sf /etc/nginx/sites-available/wordworld /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

Then attach a static IP in the Lightsail console, point your domain's A record
at it, and get a free certificate:

```bash
sudo snap install --classic certbot
sudo certbot --nginx -d yourdomain.com
```

Set a billing alarm before you do anything else. AWS has no spending cap by
default.

## 2. Scaling up, when traffic justifies it

The jump to ALB + ECS Fargate + RDS + ElastiCache costs roughly $70–120/month
in fixed charges regardless of traffic, so only make it when a single instance
is actually struggling. The steps, in the order they start to matter:

1. **Move the database to RDS Postgres.** See "Moving to Postgres" in the
   root README. This is the first real bottleneck, because SQLite writes
   serialise.
2. **Put the client on S3 + CloudFront.** Serve `public/` from the CDN and
   leave the Node process handling only the API and WebSocket traffic. Cheap,
   and it takes the bulk of requests off your instance.
3. **Add Redis (ElastiCache) for leaderboards and pub/sub.** Two jobs: sorted
   sets replace the `ORDER BY total_score` query, and pub/sub lets multiple
   server instances relay claims to each other. See `broadcastClaim` in
   `server/index.js` — it is written so that only the delivery step changes.
4. **Run several instances behind an ALB.** Enable stickiness and make sure
   the target group's idle timeout is above the 30 second WebSocket heartbeat
   in `server/index.js`, or connections will be culled mid-session.

Note that step 3 must come before step 4: until claims travel through Redis,
two instances cannot see each other's finds, and players on different servers
would see different worlds.

## Container option

The `Dockerfile` in the project root works on Render, Railway, Fly.io, or ECS.
Mount a volume at `/data` so the SQLite database survives redeploys, and set
`WORLD_SEED` in the platform's environment settings.

```bash
docker build -t wordworld .
docker run -p 3000:3000 -v wordworld-data:/data -e WORLD_SEED=... wordworld
```
