# Walrus Seal Example

1. deploy contract

```
cd contract && ./deploy.sh
```

2. check a new package

```
cd .. && cat .env.public
```

3. set a user private key

```
cp .env.example .env
vi .env
```

4. install npm

```
npm i
```

5. check allowlist

```
npm run check-allowlist
```

6. create a new allowlist (object)

```
npm run create-allowlist
```

7. add allow address into allowlist

```
npm run add-allowlist-address
```

8. upload secret-key (if not existed, script will create a new random key)

```
npm run upload-secret-key
```

9. download encrypted-key

```
npm run down-encrypted-key
```

10. download decrypted-key

```
npm run
```
