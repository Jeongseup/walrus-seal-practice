import { getFullnodeUrl } from "@mysten/sui.js/client";
import { createNetworkConfig } from "@mysten/dapp-kit";

// .env 파일에서 환경 변수 읽기
// Vite에서는 VITE_ 접두사가 필요하며, import.meta.env로 접근
const testnetPackageId = import.meta.env.VITE_TESTNET_PACKAGE_ID || "";
const testnetGameId = import.meta.env.VITE_TESTNET_GAME_ID || "";
const moduleName = import.meta.env.VITE_MODULE_NAME || "mosaic";

const mainnetPackageId = import.meta.env.VITE_MAINNET_PACKAGE_ID || "";
const mainnetGameId = import.meta.env.VITE_MAINNET_GAME_ID || "";

const { networkConfig, useNetworkVariable } = createNetworkConfig({
	testnet: {
		url: getFullnodeUrl("testnet"),
		variables: {
			packageId: testnetPackageId,
			gameId: testnetGameId,
			moduleName: moduleName,
		},
	},
	mainnet: {
		url: getFullnodeUrl("mainnet"),
		variables: {
			packageId: mainnetPackageId,
			gameId: mainnetGameId,
			moduleName: moduleName,
		},
	},
});

export { networkConfig, useNetworkVariable };
