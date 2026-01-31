# LegoCollector


## 1. Pré-requisitos

Instale o **Node.js** e o **Git**:

```bash
sudo apt update
sudo apt install nodejs npm git -y

mkdir lego-tracker
cd lego-tracker
```

## 2. Instale as bibliotecas:

```bash
npm install
```

## 3. Crie o seu ficheiro .env a partir do exemplo e preencha a chave da API:

```bash
TO BE DONE
```

## 4. Obtenha os dados iniciais:
Certifique-se que colocou sua API Key no arquivo .env.
Rode o script de sincronização (pode demorar um pouco):

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

