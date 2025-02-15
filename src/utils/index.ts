import axios from "axios";
interface TokenPrice {
  price: number;
  symbol: string;
  decimal: number;
}

export async function getTokenPrice(tokenId: string): Promise<TokenPrice> {
  try {
    const response = await axios.post(
      "https://api.hashpack.app/prices",
      {
        network: "mainnet",
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    const tokenData = response.data.find((token: any) => token.id === tokenId);

    if (tokenData) {
      return {
        price: parseFloat(tokenData.priceUsd),
        decimal: tokenData.decimals,
        symbol: tokenData.symbol,
      };
    }
    return { price: 0.1, decimal: 6, symbol: "TEST" };
  } catch (error) {
    console.error("Error fetching token price:", error);
    throw error;
  }
}

export async function getTokenPool(
  tokenAId: string,
  tokenBId: string
): Promise<string> {
  try {
    const response = await axios.post(
      "https://api.hashpack.app/poolsV2",
      {
        network: "mainnet",
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    const tokenData = response.data.find(
      (token: any) =>
        token.tokenA.id === tokenAId && token.tokenB.id === tokenBId
    );

    if (tokenData) {
      return tokenData.contractId;
    }
    return "0.0.3964795";
  } catch (error) {
    console.error("Error fetching token price:", error);
    throw error;
  }
}
