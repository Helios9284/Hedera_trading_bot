import TelegramBot from "node-telegram-bot-api";

import {
  Client,
  TokenType,
  PrivateKey,
  ContractId,
  AccountCreateTransaction,
  TransferTransaction,
  TokenCreateTransaction,
  AccountBalanceQuery,
  Hbar,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  TokenAssociateTransaction,
} from "@hashgraph/sdk";
import storage from "node-persist";
import QRCode from "qrcode";
import { getTokenPrice } from "../utils";

storage.init();

interface UserSession {
  accountId: string;
  privateKey: string;
}

export class TelegramService {
  private bot: TelegramBot;
  private client: Client;
  private client_buy: Client;
  private client_sell: Client;

  constructor(token: string, accountId: string, privateKey: string) {
    this.bot = new TelegramBot(token, {
      polling: true,
    });

    this.client = Client.forMainnet();
    this.client_buy = Client.forMainnet();
    this.client_sell = Client.forMainnet();

    this.client.setOperator(accountId, privateKey);
    this.client_buy.setOperator(accountId, privateKey);
    this.client_sell.setOperator(accountId, privateKey);

    this.setUpHandlers();
    this.initializeCommands();
  }

  private setUpHandlers(): void {
    this.bot.on("callback_query", this.handleCallback.bind(this));
  }

  private async generateQRCode(accountId: string): Promise<Buffer> {
    try {
      return await QRCode.toBuffer(accountId, {
        errorCorrectionLevel: "H",
        margin: 1,
        width: 300,
      });
    } catch (error) {
      console.error("Error generating QR code:", error);
      throw error;
    }
  }

  private async getWalletBalance(accountId: string): Promise<number> {
    try {
      const accountBalance = await new AccountBalanceQuery()
        .setAccountId(accountId)
        .execute(this.client);

      return parseFloat(accountBalance.hbars.toString());
    } catch (error) {
      console.error("Error getting balance:", error);
      throw error;
    }
  }

  private async getTokenBalance(
    accountId: string,
    tokenId: string
  ): Promise<number> {
    try {
      console.log("accountID:", accountId);
      const query = new AccountBalanceQuery().setAccountId(accountId);

      const accountBalance = await query.execute(this.client);
      const tokenBalance = accountBalance.tokens?._map.get(tokenId.toString());

      return tokenBalance ? parseFloat(tokenBalance.toString()) : 0;
    } catch (error) {
      console.error("Error getting token balance:", error);
      throw error;
    }
  }

  private initializeCommands(): void {
    this.bot.onText(/\/start/, async (msg) => {
      const userId = msg.from!.id;
      const chatId = msg.chat.id;

      try {
        const userExists = await this.checkUserExists(userId);

        if (userExists) {
          await this.showMainMenu(chatId);
        } else {
          await this.createNewWallet(chatId, userId);
        }
      } catch (error) {
        console.error("Error in /start command:", error);
        await this.bot.sendMessage(
          chatId,
          "Sorry, something went wrong. Please try again later."
        );
      }
    });
    this.bot.onText(/\/testtoken/, async (msg) => {
      const chatId = msg.chat.id;
      const userId = msg.from!.id;

      try {
        const userState = await this.getUserState(userId);
        if (!userState || !userState.accountId) {
          await this.bot.sendMessage(
            chatId,
            "❌ Please create a wallet first using /start"
          );
          return;
        }

        // Create token transaction
        const transaction = await new TokenCreateTransaction()
          .setTokenName("HBAR SELL TOKEN")
          .setTokenType(TokenType.FungibleCommon)
          .setTokenSymbol("HST")
          .setDecimals(2)
          .setInitialSupply(1000000) // 1M tokens
          .setTreasuryAccountId(this.client.operatorAccountId!) // Treasury is the bot operator
          .setAdminKey(this.client.operatorPublicKey!)
          .setSupplyKey(this.client.operatorPublicKey!)
          .freezeWith(this.client);

        // Sign with admin key
        const signedTx = await transaction.sign(
          PrivateKey.fromString(process.env.MY_PRIVATE_KEY!)
        );

        // Submit the transaction
        const response = await signedTx.execute(this.client);
        const receipt = await response.getReceipt(this.client);
        const tokenId = receipt.tokenId;

        await this.bot.sendMessage(
          chatId,
          `✅ Test Token Created!\n\n` +
            `Token ID: \`${tokenId}\`\n` +
            `Name: Test Token\n` +
            `Symbol: TEST\n` +
            `Initial Supply: 1,000,000\n` +
            `Decimals: 6\n\n` +
            `You can now use this token ID to test buy/sell functions.`,
          { parse_mode: "Markdown" }
        );
      } catch (error) {
        console.error("Error creating token:", error);
        await this.bot.sendMessage(
          chatId,
          "❌ Failed to create test token. Please try again later."
        );
      }
    });
  }

  private async showMainMenu(chatId: number): Promise<void> {
    const options = {
      inline_keyboard: [
        [
          { text: "💰 Deposit", callback_data: "deposit" },
          { text: "📤 Withdraw", callback_data: "withdraw" },
        ],
        [
          { text: "🛒 Buy", callback_data: "buy" },
          { text: "💵 Sell", callback_data: "sell" },
        ],
      ],
    };

    await this.bot.sendMessage(
      chatId,
      "Welcome back! What would you like to do?",
      { reply_markup: options }
    );
  }

  private async handleCallback(query: TelegramBot.CallbackQuery) {
    const userId = query.from.id;
    const chatId = query.message?.chat.id;
    const data = query.data;

    if (data === "menu") {
      this.showMainMenu(chatId!);
    }
    if (data === "download_pk") {
      await this.bot.deleteMessage(chatId!, query.message?.message_id!);
      const userState = await this.getUserState(userId);
      console.log("privatekey:", userState.privateKey);
      const jsonContent = JSON.stringify(
        {
          privateKey: userState.privateKey,
        },
        null,
        2
      );

      const buffer = Buffer.from(jsonContent, "utf-8");

      const sentMessage = await this.bot.sendDocument(
        chatId!,
        buffer,
        {
          caption:
            "🔐 Here is your wallet information. Store it securely! Download in 5 mins",
          parse_mode: "Markdown",
        },
        {
          filename: `hedera_wallet.json`,
          contentType: "application/json",
        }
      );

      setTimeout(async () => {
        try {
          // Delete the document message
          await this.bot.deleteMessage(chatId!, sentMessage.message_id);

          // Show main menu
          await this.showMainMenu(chatId!);
        } catch (error) {
          console.error("Error deleting message:", error);
        }
      }, 300000); // 5 minutes

      // Answer callback query to remove loading state
      await this.bot.answerCallbackQuery(query.id);
    }
    if (data === "deposit") {
      const userState = await this.getUserState(userId);

      if (!userState || !userState.accountId) {
        await this.bot.sendMessage(
          chatId!,
          "❌ Wallet not found. Please create a wallet first using /start"
        );
        return;
      }

      const balance = await this.getWalletBalance(userState.accountId);

      const message =
        `💰 *Deposit HBAR*\n\n` +
        `Your Hedera Account ID:\n` +
        `\`${userState.accountId}\`\n\n` +
        `Your Balance: ${balance} hbar\n\n` +
        `Instructions:\n` +
        `1. Copy your Account ID above\n` +
        `2. Send HBAR from your wallet/exchange to this account\n` +
        `3. Wait for the transaction to be confirmed\n\n` +
        `⚠️ Important:\n` +
        `• Transactions are irreversible`;

      await this.bot.sendMessage(chatId!, message, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🔄 Return to Menu",
                callback_data: "menu",
              },
            ],
          ],
        },
      });

      try {
        const qrBuffer = await this.generateQRCode(userState.accountId);
        await this.bot.sendPhoto(chatId!, qrBuffer, {
          caption: "📱 Scan this QR code to copy your Account ID",
        });
      } catch (error) {
        console.error("Error generating QR code:", error);
      }

      await this.bot.answerCallbackQuery(query.id);
    }
    if (data === "withdraw") {
      const userState = await this.getUserState(userId);
      if (!userState || !userState.accountId) {
        await this.bot.sendMessage(
          chatId!,
          "❌ Wallet not found. Please create a wallet first using /start"
        );
        return;
      }
      const balance = await this.getWalletBalance(userState.accountId);
      if (balance < 0.1) {
        await this.bot.sendMessage(
          chatId!,
          "❌ Insufficient balance. Please deposit more HBAR."
        );
        return;
      } else {
        await this.bot.sendMessage(
          chatId!,
          "📤 *Withdraw HBAR*\n\n" +
            `Your current balance: ${balance} hbar\n\n` +
            "Please enter the destination Hedera account ID (e.g., 0.0.1234)",
          {
            parse_mode: "Markdown",
            reply_markup: {
              force_reply: true,
              selective: true,
            },
          }
        );

        this.bot.once("message", async (destMsg) => {
          if (destMsg.chat.id !== chatId) return;
          const destinationId = destMsg.text;

          if (!/^\d+\.\d+\.\d+$/.test(destinationId!)) {
            await this.bot.sendMessage(
              chatId!,
              "❌ Invalid account ID format. Please use the format: 0.0.1234\n\nWithdrawal cancelled."
            );
            return;
          }

          await this.bot.sendMessage(
            chatId!,
            "💰 Enter the amount of HBAR to withdraw:",
            {
              reply_markup: {
                force_reply: true,
                selective: true,
              },
            }
          );

          this.bot.once("message", async (amountMsg) => {
            if (amountMsg.chat.id !== chatId) return;
            const amount = parseFloat(amountMsg.text!);

            if (isNaN(amount) || amount <= 0) {
              await this.bot.sendMessage(
                chatId!,
                "❌ Invalid amount. Please enter a positive number.\n\nWithdrawal cancelled."
              );
              return;
            }

            await this.bot.sendMessage(
              chatId!,
              `🔍 *Confirm Withdrawal*\n\n` +
                `From: \`${userState.accountId}\`\n` +
                `To: \`${destinationId}\`\n` +
                `Amount: ${amount} HBAR\n\n` +
                `Please confirm this transaction:`,
              {
                parse_mode: "Markdown",
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: "✅ Confirm",
                        callback_data: `confirm_withdraw_${destinationId}_${amount}`,
                      },
                      { text: "❌ Cancel", callback_data: "cancel_withdraw" },
                    ],
                  ],
                },
              }
            );
          });
        });
      }
      await this.bot.answerCallbackQuery(query.id);
    }
    if (data?.startsWith("confirm_withdraw_")) {
      const [, , destinationId, amount] = data.split("_");
      try {
        const userState = await this.getUserState(userId);

        // Create transfer transaction
        const transaction = await new TransferTransaction()
          .addHbarTransfer(userState.accountId, new Hbar(-amount)) // Negative for sender
          .addHbarTransfer(destinationId, new Hbar(amount)) // Positive for receiver
          .setTransactionMemo("Telegram Bot Withdrawal")
          .freezeWith(this.client);

        // Sign with sender's private key
        const signedTx = await transaction.sign(
          PrivateKey.fromString(userState.privateKey.slice(-64))
        );

        const response = await signedTx.execute(this.client);

        // Get the receipt
        const receipt = await response.getReceipt(this.client);

        if (receipt.status.toString() === "SUCCESS") {
          await this.bot.sendMessage(
            chatId!,
            "✅ Withdrawal successful!\n\n" +
              `Amount: ${amount} HBAR\n` +
              `Destination: ${destinationId}\n` +
              `Transaction ID: ${response.transactionId.toString()}`
          );
        } else {
          throw new Error(`Transaction failed with status: ${receipt.status}`);
        }
      } catch (error) {
        console.error("Withdrawal error:", error);
        await this.bot.sendMessage(
          chatId!,
          "❌ Withdrawal failed. Please try again later."
        );
      }
    }
    if (data === "cancel_withdraw") {
      await this.bot.sendMessage(chatId!, "❌ Withdrawal cancelled.");
      await this.showMainMenu(chatId!);
    }
    if (data === "buy") {
      const userState = await this.getUserState(userId);
      if (!userState || !userState.accountId) {
        await this.bot.sendMessage(
          chatId!,
          "❌ Wallet not found. Please create a wallet first using /start"
        );
        return;
      }
      const balance = await this.getWalletBalance(userState.accountId);
      if (balance < 0.1) {
        await this.bot.sendMessage(
          chatId!,
          "❌ Insufficient balance. Please deposit more HBAR."
        );
        return;
      } else {
        await this.bot.sendMessage(
          chatId!,
          "🪙 *Buy Tokens*\n\n" +
            `Your Balance: ${balance} hbar\n\n` +
            "Please enter the token ID (e.g., 0.0.1234):",
          {
            parse_mode: "Markdown",
            reply_markup: {
              force_reply: true,
              selective: true,
            },
          }
        );

        // Listen for token ID
        this.bot.once("message", async (tokenMsg) => {
          if (tokenMsg.chat.id !== chatId) return;
          const tokenId = tokenMsg.text;

          let response = await getTokenPrice(tokenId!);
          const tokenPrice = response.price;
          const tokenDecimal = response.decimal;
          console.log("tokenPrice:", tokenPrice, tokenDecimal);
          // Validate token ID format
          if (!/^\d+\.\d+\.\d+$/.test(tokenId!)) {
            await this.bot.sendMessage(
              chatId!,
              "❌ Invalid token ID format. Please use the format: 0.0.1234\n\nPurchase cancelled."
            );
            return;
          }

          // Ask for token amount
          await this.bot.sendMessage(
            chatId!,
            "🔢 Enter the amount of tokens you want to spend:",
            {
              reply_markup: {
                force_reply: true,
                selective: true,
              },
            }
          );

          // Listen for token amount
          this.bot.once("message", async (amountMsg) => {
            if (amountMsg.chat.id !== chatId) return;
            const tokenAmount = parseFloat(amountMsg.text!);

            if (isNaN(tokenAmount) || tokenAmount <= 0) {
              await this.bot.sendMessage(
                chatId!,
                "❌ Invalid amount. Please enter a positive number.\n\nPurchase cancelled."
              );
              return;
            }

            try {
              const hbarPrice = await getTokenPrice("0.0.1456986");
              const hbarAmount = (hbarPrice.price * tokenAmount) / tokenPrice;

              await this.bot.sendMessage(
                chatId!,
                `🔍 *Confirm Purchase*\n\n` +
                  `Token ID: \`${tokenId}\`\n` +
                  `Amount to buy: ${hbarAmount.toFixed(4)} tokens\n` +
                  `Cost: ${tokenAmount} HBAR\n\n` +
                  `Please confirm this transaction:`,
                {
                  parse_mode: "Markdown",
                  reply_markup: {
                    inline_keyboard: [
                      [
                        {
                          text: "✅ Confirm",
                          callback_data: `confirm_buy_${tokenId}_${hbarAmount}_${tokenAmount}`,
                        },
                        { text: "❌ Cancel", callback_data: "cancel_buy" },
                      ],
                    ],
                  },
                }
              );
            } catch (error) {
              console.error("Error preparing buy:", error);
              await this.bot.sendMessage(
                chatId!,
                "❌ Error preparing purchase. Please try again later."
              );
            }
          });
        });
      }

      await this.bot.answerCallbackQuery(query.id);
    }

    if (data?.startsWith("confirm_buy_")) {
      const [, , tokenId, tokenAmount, hbarAmount] = data.split("_");
      const userState = await this.getUserState(userId);
      const response = await getTokenPrice(tokenId);
      const tokenSymbol = response.symbol;
      const tokenDecimal = response.decimal;

      console.log(
        "tokenInfo:",
        tokenId,
        tokenSymbol,
        tokenAmount,
        hbarAmount,
        tokenDecimal
      );
      try {
        const balance = await this.getTokenBalance(
          userState.accountId,
          tokenId
        );
        console.log("token Balance:", balance);
        if (balance === 0) {
          try{
          const tokenAssociateTx = new TokenAssociateTransaction()
            .setAccountId(userState.accountId)
            .setTokenIds([tokenId])
            .freezeWith(this.client_buy);
          const accountkey = PrivateKey.fromString(userState.privateKey);
          const signTx = await tokenAssociateTx.sign(accountkey);
          const tx_associate = await signTx.execute(this.client_buy);
          const tx_receipt = await tx_associate.getReceipt(this.client_buy);

          if (tx_receipt.status.toString() === "SUCCESS") {
            console.log("Token is associated");
          }} catch (error){
            console.log("error:", error);
          }
        }

        const poolsContractId = ContractId.fromString("0.0.3045981");
        this.client_buy.setOperator(userState.accountId, userState.privateKey);

        const deadline = new Date().getTime() + 1000 * 60 * 20;

        const hbarAmountInwei = Math.floor(Number(hbarAmount) * 10 ** 8);
        console.log("hbarAmountInwei:", hbarAmountInwei);
        const tokenPair = [
          this.convertHederaContractIdToEVMAddress("0.0.1456986"),
          this.convertHederaContractIdToEVMAddress(tokenId),
        ];
        console.log("tokenPair:", tokenPair);
        const transaction = new ContractExecuteTransaction()
          .setContractId(poolsContractId)
          .setFunction(
            "swapExactETHForTokens",
            new ContractFunctionParameters()
              .addUint256(0)
              .addAddressArray(tokenPair)
              .addAddress(
                this.convertHederaContractIdToEVMAddress(userState.accountId)
              )
              .addUint256(deadline)
          )
          .setPayableAmount(hbarAmount)
          .setGas(1120000)
          .freezeWith(this.client_buy);

        const txResponse = await transaction.execute(this.client_buy);
        const receipt = await txResponse.getReceipt(this.client_buy);

        if (receipt.status.toString() === "SUCCESS") {
          await this.bot.sendMessage(
            chatId!,
            "✅ Purchase successful!\n\n" +
              `Tokens bought: ${tokenAmount} ${tokenSymbol}\n` +
              `Amount paid: ${hbarAmount} HBAR\n` +
              `Transaction ID: ${txResponse.transactionId.toString()}`
          );
        } else {
          throw new Error(`Transaction failed with status: ${receipt.status}`);
        }
      } catch (error) {
        console.error("Purchase error:", error);
        await this.bot.sendMessage(
          chatId!,
          "❌ Purchase failed. Please try again later.\n" +
            "Make sure you have enough HBAR balance."
        );
      }
    }

    if (data === "cancel_buy") {
      try {
        await this.bot.sendMessage(
          chatId!,
          "❌ Purchase cancelled.\n\nReturning to main menu..."
        );

        await this.showMainMenu(chatId!);

        await this.bot.answerCallbackQuery(query.id);
      } catch (error) {
        console.error("Error handling cancel:", error);
      }
    }

    if (data === "sell") {
      const userState = await this.getUserState(userId);
      this.client_sell.setOperator(userState.accountId, userState.privateKey);

      if (!userState || !userState.accountId) {
        await this.bot.sendMessage(
          chatId!,
          "❌ Wallet not found. Please create a wallet first using /start"
        );
        return;
      }

      await this.bot.sendMessage(
        chatId!,
        "💰 *Sell Tokens*\n\n" + "Please enter the token ID (e.g., 0.0.1234):",
        {
          parse_mode: "Markdown",
          reply_markup: {
            force_reply: true,
            selective: true,
          },
        }
      );

      this.bot.once("message", async (tokenMsg) => {
        if (tokenMsg.chat.id !== chatId) return;
        const tokenId = tokenMsg.text;

        if (!/^\d+\.\d+\.\d+$/.test(tokenId!)) {
          await this.bot.sendMessage(
            chatId!,
            "❌ Invalid token ID format. Please use the format: 0.0.1234\n\nSale cancelled."
          );
          return;
        }

        await this.bot.sendMessage(
          chatId!,
          "🔢 Click the amount type of tokens you want to sell:",
          {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "Sell", callback_data: "sell_manual" },
                  { text: "Sell All", callback_data: "sell_all" },
                ],
              ],
              force_reply: true,
              selective: true,
            },
          }
        );
        this.bot.once("callback_query", async (amountMsg) => {
          if (amountMsg.data === "sell_all") {
            try {
              const tokenBalance = await this.getTokenBalance(
                userState.accountId,
                tokenId!
              );
              const res = await getTokenPrice(tokenId!);
              const tokenSymbol = res.symbol;
              const tokenDecimal = res.decimal;
              const tokenContractId = ContractId.fromString(tokenId!);
              console.log("tokenBalance:", tokenBalance);
              const transaction = new ContractExecuteTransaction()
                .setContractId(tokenContractId)
                .setFunction(
                  "approve",
                  new ContractFunctionParameters()
                    .addAddress(
                      this.convertHederaContractIdToEVMAddress("0.0.3045981")
                    )
                    .addUint256(tokenBalance)
                )
                .setGas(854241)
                .freezeWith(this.client_sell);

              const txResponse = await transaction.execute(this.client_sell);
              const receipt = await txResponse.getReceipt(this.client_sell);

              if (receipt.status.toString() === "SUCCESS") {
                const deadline = new Date().getTime() + 1000 * 60 * 20;
                const poolsContractId = ContractId.fromString("0.0.3045981");
                const tokenPair = [
                  this.convertHederaContractIdToEVMAddress(tokenId!),
                  this.convertHederaContractIdToEVMAddress("0.0.1456986"),
                ];
                console.log("tokenPair:", tokenPair);
                const transaction = new ContractExecuteTransaction()
                  .setContractId(poolsContractId)
                  .setFunction(
                    "swapExactTokensForETH",
                    new ContractFunctionParameters()
                      .addUint256(tokenBalance)
                      .addUint256(0)
                      .addAddressArray(tokenPair)
                      .addAddress(
                        this.convertHederaContractIdToEVMAddress(
                          userState.accountId
                        )
                      )
                      .addUint256(deadline)
                  )
                  .setGas(1120000)
                  .freezeWith(this.client_sell);

                const txResponse = await transaction.execute(this.client_sell);
                const receipt = await txResponse.getReceipt(this.client_sell);
                const soldValue = tokenBalance / 10 ** tokenDecimal;
                if (receipt.status.toString() === "SUCCESS") {
                  await this.bot.sendMessage(
                    chatId!,
                    "✅ Purchase successful!\n\n" +
                      `Token Sold: ${soldValue.toFixed(3)} ${tokenSymbol}\n` +
                      `Transaction ID: ${txResponse.transactionId.toString()}`
                  );
                } else {
                  this.showMainMenu(chatId);
                  throw new Error(
                    `Transaction failed with status: ${receipt.status}`
                  );
                }
              } else {
                throw new Error(
                  `Transaction failed with status: ${receipt.status}`
                );
              }
            } catch (error) {
              console.error("Purchase error:", error);
              await this.bot.sendMessage(
                chatId!,
                "❌ Purchase failed. Please try again later.\n" +
                  "Make sure you have enough HBAR balance."
              );
            }
          }
          if (amountMsg.data === "sell_manual") {
            const tokenInfo = await getTokenPrice(tokenId!);
            const tokenBalance = await this.getTokenBalance(
              userState.accountId,
              tokenId!
            );
            const FormatedTokenBalance =
              Number(tokenBalance) / 10 ** tokenInfo.decimal;
            console.log("tokenBalance:", tokenBalance);
            await this.bot.sendMessage(
              chatId!,
              `Your current balance: ${FormatedTokenBalance.toFixed(4)} ${tokenInfo.symbol}\n\n` +
                "🔢 Enter the amount of tokens you want to sell: ",
              {
                reply_markup: {
                  force_reply: true,
                  selective: true,
                },
              }
            );
            this.bot.once("message", async (amountMsg) => {
              if (amountMsg.chat.id !== chatId) return;
              const tokenAmount = parseFloat(amountMsg.text!);
              console.log("tokenAmount:", tokenAmount);
              if (isNaN(tokenAmount) || tokenAmount <= 0) {
                await this.bot.sendMessage(
                  chatId!,
                  "❌ Invalid amount. Please enter a positive number.\n\nSale cancelled."
                );
                return;
              }

              try {
                const tokenInfo = await getTokenPrice(tokenId!);
                const hbarInfo = await getTokenPrice("0.0.1456986");
                const tokenSymbol = tokenInfo.symbol;
                const hbarAmount =
                  (tokenAmount * tokenInfo.price) / hbarInfo.price;

                await this.bot.sendMessage(
                  chatId!,
                  `🔍 *Confirm Sale*\n\n` +
                    `Token ID: \`${tokenId}\`\n` +
                    `Amount to sell: ${tokenAmount} ${tokenSymbol}\n` +
                    `Price per token: ${tokenInfo.price.toFixed(6)} HBAR\n` +
                    `You will receive: ${hbarAmount.toFixed(3)} HBAR\n\n` +
                    `Please confirm this transaction:`,
                  {
                    parse_mode: "Markdown",
                    reply_markup: {
                      inline_keyboard: [
                        [
                          {
                            text: "✅ Confirm",
                            callback_data: `confirm_sell_${tokenId}_${tokenAmount}_${hbarAmount}`,
                          },
                          { text: "❌ Cancel", callback_data: "cancel_sell" },
                        ],
                      ],
                    },
                  }
                );
              } catch (error) {
                console.error("Error preparing sell:", error);
                await this.bot.sendMessage(
                  chatId!,
                  "❌ Error preparing sale. Please try again later."
                );
              }
            });
          }
        });
      });

      await this.bot.answerCallbackQuery(query.id);
    }

    if (data?.startsWith("confirm_sell_")) {
      const [, , tokenId, tokenAmount] = data.split("_");
      console.log("tokenId:", tokenId, tokenAmount);
      try {
        const userState = await this.getUserState(userId);
        const tokenInfo = await getTokenPrice(tokenId);
        const tokenDecimal = tokenInfo.decimal;
        const tokenBalance = await this.getTokenBalance(
          userState.accountId,
          tokenId
        );
        if (tokenBalance < parseFloat(tokenAmount)) {
          await this.bot.sendMessage(
            chatId!,
            `❌ Insufficient token balance!\n\n` +
              `Required: ${tokenAmount} tokens\n` +
              `Your balance: ${tokenBalance} tokens`
          );
          return;
        }

        try {
          const tokenContractId = ContractId.fromString(tokenId!);

          const transaction = new ContractExecuteTransaction()
            .setContractId(tokenContractId)
            .setFunction(
              "approve",
              new ContractFunctionParameters()
                .addAddress(
                  this.convertHederaContractIdToEVMAddress("0.0.3045981")
                )
                .addUint256(Number(tokenAmount) * 10 ** tokenDecimal)
            )
            .setGas(854241)
            .freezeWith(this.client);

          const txResponse = await transaction.execute(this.client);
          const receipt = await txResponse.getReceipt(this.client);
          if (receipt.status.toString() === "SUCCESS") {
            const deadline = new Date().getTime() + 1000 * 60 * 20;
            const poolsContractId = ContractId.fromString("0.0.3045981");
            const tokenPair = [
              this.convertHederaContractIdToEVMAddress(tokenId!),
              this.convertHederaContractIdToEVMAddress("0.0.1456986"),
            ];
            const transaction = new ContractExecuteTransaction()
              .setContractId(poolsContractId)
              .setFunction(
                "swapExactTokensForETH",
                new ContractFunctionParameters()
                  .addUint256(Number(tokenAmount) * 10 ** tokenDecimal)
                  .addUint256(0)
                  .addAddressArray(tokenPair)
                  .addAddress(
                    this.convertHederaContractIdToEVMAddress(
                      userState.accountId
                    )
                  )
                  .addUint256(deadline)
              )
              .setGas(1120000)
              .freezeWith(this.client);

            const txResponse = await transaction.execute(this.client);
            const receipt = await txResponse.getReceipt(this.client);

            if (receipt.status.toString() === "SUCCESS") {
              await this.bot.sendMessage(
                chatId!,
                "✅ Purchase successful!\n\n" +
                  `Tokens Sold: ${tokenAmount} \n` +
                  `Transaction ID: ${txResponse.transactionId.toString()}`
              );
            } else {
              throw new Error(
                `Transaction failed with status: ${receipt.status}`
              );
            }
          }
        } catch (error) {
          console.error("Purchase error:", error);
          await this.bot.sendMessage(
            chatId!,
            "❌ Purchase failed. Please try again later.\n" +
              "Make sure you have enough HBAR balance."
          );
        }
      } catch (error) {
        console.error("Sale error:", error);
        await this.bot.sendMessage(
          chatId!,
          "❌ Sale failed. Please try again later.\n" +
            "Make sure you have enough tokens to sell."
        );
      }
    }

    if (data === "cancel_sell") {
      try {
        await this.bot.sendMessage(
          chatId!,
          "❌ Sale cancelled.\n\nReturning to main menu..."
        );
        await this.showMainMenu(chatId!);
        await this.bot.answerCallbackQuery(query.id);
      } catch (error) {
        console.error("Error handling cancel:", error);
      }
    }
  }
  private convertHederaContractIdToEVMAddress(hederaContractId: string) {
    const parts = hederaContractId.split(".");
    const id = parts[2];
    const hex = BigInt(id).toString(16).padStart(40, "0");
    return `0x${hex}`;
  }

  private async createNewWallet(chatId: number, userId: number): Promise<void> {
    try {
      const privateKey = PrivateKey.generateED25519();
      const publicKey = privateKey.publicKey;

      const transaction = new AccountCreateTransaction()
        .setKey(publicKey)
        .setInitialBalance(0);

      const response = await transaction.execute(this.client);
      const receipt = await response.getReceipt(this.client);
      const accountId = receipt.accountId;

      await this.storeUserData(
        userId,
        accountId!.toString(),
        privateKey.toString().slice(-64)
      );

      await this.bot.sendMessage(
        chatId,
        `✅ Your new Hedera wallet has been created!\n\n` +
          `Account ID: \`${accountId}\`\n\n` +
          `Private Key: \`${privateKey.toString()}\`\n\n` +
          `⚠️ Please save your private key securely. It will only be shown once!`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "📥 Download Private Key",
                  callback_data: `download_pk`,
                },
              ],
            ],
          },
          parse_mode: "Markdown",
        }
      );
    } catch (error) {
      console.error("Error creating wallet:", error);
      await this.bot.sendMessage(
        chatId,
        "Sorry, there was an error creating your wallet. Please try again later."
      );
    }
  }

  private async storeUserData(
    userId: number,
    accountId: string,
    privateKey: string
  ): Promise<void> {
    let userState = await storage.getItem(`user_${userId}`);
    userState.accountId = accountId;
    userState.privateKey = privateKey;
    await storage.setItem(`user_${userId}`, userState);
  }

  private async getUserState(userId: number): Promise<UserSession> {
    let userState = await storage.getItem(`user_${userId}`);
    if (!userState) {
      userState = {
        accountId: "",
        privateKey: "",
      };
      await storage.setItem(`user_${userId}`, userState);
    }
    return userState;
  }

  private async checkUserExists(userId: number): Promise<boolean> {
    const userState = await this.getUserState(userId);
    if (userState.accountId !== "") return true;
    return false;
  }

  public start(): void {
    console.log("Telegram bot started");
  }
}
