# LegoCollector

```bash
git clone https://github.com/ColdShadow80/LegoCollector.git
```

## 1. Pré-requisitos

Instale o **Node.js** e o **Git**:

```bash
sudo apt update
sudo apt install nodejs npm git -y

```

## 2. Instale as bibliotecas:

```bash
npm install
```

2.1. Instale as bibliotecas adicionais para a atualização em batch no primeiro arranque:
(As bibliotecas zlib e fs já são nativas do Node.js)

```bash
npm install csv-parser
```

## 3. Crie o seu ficheiro .env a partir do exemplo e preencha a chave da API:

```bash
cp .env.example .env
```

## 4.1 Obtenha os dados iniciais:
Certifique-se que colocou sua API Key no arquivo .env.


## 4.1 Rode o script de importação inicial

```bash
node setup_bulk.js
```

## 4.2 OPCIONAL - Rode o script de sincronização adicional (apenas para obter dados recentes (pode demorar um pouco):

```bash
npm run sync
```

## 5. Inicie o site:

```bash
npm start
```

## Próximo Passo: Colocar em Produção (Debian)
Para que o site fique rodando 24/7 mesmo que você feche o terminal, use o PM2:

```bash
sudo npm install -g pm2
pm2 start server.js --name "lego-app"
pm2 startup
pm2 save
```

