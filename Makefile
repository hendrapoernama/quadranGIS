.PHONY: cert up down logs be fe seed-bulk

cert: ## buat sertifikat self-signed untuk https://localhost
	bash scripts/gen-cert.sh localhost

up: ## jalankan seluruh stack (HTTPS di https://localhost)
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f backend

be: ## jalankan backend lokal (butuh postgres/redis/kafka aktif)
	cd backend && go run ./cmd/server

fe: ## jalankan frontend lokal (dev)
	cd frontend && npm run dev

seed-bulk: ## simulasi massal: 100 GI, 1.000 penyulang, 50.000 GD, 2 juta pelanggan (5-15 menit)
	docker compose exec -T postgres psql -U quadran -d quadrangis -v ON_ERROR_STOP=1 -f - < scripts/seed_bulk.sql
	docker compose restart backend

remove-bulk: ## hapus data simulasi massal
	docker compose exec -T postgres psql -U quadran -d quadrangis -v ON_ERROR_STOP=1 -f - < scripts/remove_bulk.sql
	docker compose restart backend
