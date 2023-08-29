import { BigNumber, ethers, utils, providers } from 'ethers'
import { IConditionalOrder } from './generated/ComposableCoW'

import { decodeParams, encodeParams } from './utils'
import {
  ConditionalOrderArguments,
  ConditionalOrderParams,
  ContextFactory,
  IsValidResult,
  PollResult,
  PollResultCode,
  PollResultErrors,
} from './types'
import { SupportedChainId } from '../common'
import { getComposableCow, getComposableCowInterface } from './contracts'

/**
 * An abstract base class from which all conditional orders should inherit.
 *
 * This class provides some basic functionality to help with handling conditional orders,
 * such as:
 * - Validating the conditional order
 * - Creating a human-readable string representation of the conditional order
 * - Serializing the conditional order for use with the `IConditionalOrder` struct
 * - Getting any dependencies for the conditional order
 * - Getting the off-chain input for the conditional order
 *
 * **NOTE**: Instances of conditional orders have an `id` property that is a `keccak256` hash of
 *           the serialized conditional order.
 */
export abstract class ConditionalOrder<D, S> {
  public readonly handler: string
  public readonly salt: string
  public readonly data: D
  public readonly staticInput: S
  public readonly hasOffChainInput: boolean

  /**
   * A constructor that provides some basic validation for the conditional order.
   *
   * This constructor **MUST** be called by any class that inherits from `ConditionalOrder`.
   *
   * **NOTE**: The salt is optional and will be randomly generated if not provided.
   * @param handler The address of the handler for the conditional order.
   * @param salt A 32-byte string used to salt the conditional order.
   * @param data The data of the order
   * @param hasOffChainInput Whether the conditional order has off-chain input.
   * @throws If the handler is not a valid ethereum address.
   * @throws If the salt is not a valid 32-byte string.
   */
  constructor(params: ConditionalOrderArguments<D>) {
    const { handler, salt = utils.keccak256(utils.randomBytes(32)), data, hasOffChainInput = false } = params
    // Verify input to the constructor
    // 1. Verify that the handler is a valid ethereum address
    if (!ethers.utils.isAddress(handler)) {
      throw new Error(`Invalid handler: ${handler}`)
    }

    // 2. Verify that the salt is a valid 32-byte string usable with ethers
    if (!ethers.utils.isHexString(salt) || ethers.utils.hexDataLength(salt) !== 32) {
      throw new Error(`Invalid salt: ${salt}`)
    }

    this.handler = handler
    this.salt = salt
    this.data = data
    this.staticInput = this.transformDataToStruct(data)

    this.hasOffChainInput = hasOffChainInput
  }

  /**
   * Get a descriptive name for the type of the conditional order (i.e twap, dca, etc).
   *
   * @returns {string} The concrete type of the conditional order.
   */
  abstract get orderType(): string

  /**
   * Get the context dependency for the conditional order.
   *
   * This is used when calling `createWithContext` or `setRootWithContext` on a ComposableCoW-enabled Safe.
   * @returns The context dependency.
   */
  get context(): ContextFactory | undefined {
    return undefined
  }

  assertIsValid(): void {
    const isValidResult = this.isValid()
    if (!isValidResult.isValid) {
      throw new Error(`Invalid order: ${isValidResult.reason}`)
    }
  }

  abstract isValid(): IsValidResult

  /**
   * Get the calldata for creating the conditional order.
   *
   * This will automatically determine whether or not to use `create` or `createWithContext` based on the
   * order type's context dependency.
   *
   * **NOTE**: By default, this will cause the create to emit the `ConditionalOrderCreated` event.
   * @returns The calldata for creating the conditional order.
   */
  get createCalldata(): string {
    this.assertIsValid()

    const context = this.context
    const composableCow = getComposableCowInterface()
    const paramsStruct: IConditionalOrder.ConditionalOrderParamsStruct = {
      handler: this.handler,
      salt: this.salt,
      staticInput: this.encodeStaticInput(),
    }

    if (context) {
      // Create (with context)
      const contextArgsAbi = context.factoryArgs
        ? utils.defaultAbiCoder.encode(context.factoryArgs.argsType, context.factoryArgs.args)
        : '0x'
      return composableCow.encodeFunctionData('createWithContext', [
        paramsStruct,
        context.address,
        contextArgsAbi,
        true,
      ])
    } else {
      // Create
      return composableCow.encodeFunctionData('create', [paramsStruct, true])
    }
  }

  /**
   * Get the calldata for removing a conditional order that was created as a single order.
   * @returns The calldata for removing the conditional order.
   */
  get removeCalldata(): string {
    this.assertIsValid()

    return getComposableCowInterface().encodeFunctionData('remove', [this.id])
  }

  /**
   * Calculate the id of the conditional order (which also happens to be the key used for `ctx` in the ComposableCoW contract).
   *
   * This is a `keccak256` hash of the serialized conditional order.
   * @returns The id of the conditional order.
   */
  get id(): string {
    return utils.keccak256(this.serialize())
  }

  /**
   * Get the `leaf` of the conditional order. This is the data that is used to create the merkle tree.
   *
   * For the purposes of this library, the `leaf` is the `ConditionalOrderParams` struct.
   * @returns The `leaf` of the conditional order.
   * @see ConditionalOrderParams
   */
  get leaf(): ConditionalOrderParams {
    return {
      handler: this.handler,
      salt: this.salt,
      staticInput: this.encodeStaticInput(),
    }
  }

  /**
   * Calculate the id of the conditional order.
   * @param leaf The `leaf` representing the conditional order.
   * @returns The id of the conditional order.
   * @see ConditionalOrderParams
   */
  static leafToId(leaf: ConditionalOrderParams): string {
    return utils.keccak256(encodeParams(leaf))
  }

  /**
   * If the conditional order has off-chain input, return it!
   *
   * **NOTE**: This should be overridden by any conditional order that has off-chain input.
   * @returns The off-chain input.
   */
  get offChainInput(): string {
    return '0x'
  }

  /**
   * Create a human-readable string representation of the conditional order.
   *
   * @param tokenFormatter An optional function that takes an address and an amount and returns a human-readable string.
   */
  abstract toString(tokenFormatter?: (address: string, amount: BigNumber) => string): string

  /**
   * Serializes the conditional order into it's ABI-encoded form.
   *
   * @returns The equivalent of `IConditionalOrder.Params` for the conditional order.
   */
  abstract serialize(): string

  /**
   * Encode the `staticInput` for the conditional order.
   *
   * @returns The ABI-encoded `staticInput` for the conditional order.
   * @see ConditionalOrderParams
   */
  abstract encodeStaticInput(): string

  /**
   * A helper function for generically serializing a conditional order's static input.
   *
   * @param orderDataTypes ABI types for the order's data struct.
   * @param data The order's data struct.
   * @returns An ABI-encoded representation of the order's data struct.
   */
  protected encodeStaticInputHelper(orderDataTypes: string[], staticInput: S): string {
    return utils.defaultAbiCoder.encode(orderDataTypes, [staticInput])
  }

  /**
   * Poll a conditional order to see if it is tradeable.
   *
   * @param owner The owner of the conditional order.
   * @param p The proof and parameters.
   * @param chain Which chain to use for the ComposableCoW contract.
   * @param provider An RPC provider for the chain.
   * @param offChainInputFn A function, if provided, that will return the off-chain input for the conditional order.
   * @throws If the conditional order is not tradeable.
   * @returns The tradeable `GPv2Order.Data` struct and the `signature` for the conditional order.
   */
  async poll(owner: string, chain: SupportedChainId, provider: providers.Provider): Promise<PollResult> {
    const composableCow = getComposableCow(chain, provider)

    try {
      const isValid = this.isValid()
      // Do a validation first
      if (!isValid.isValid) {
        return {
          result: PollResultCode.DONT_TRY_AGAIN,
          reason: `InvalidConditionalOrder. Reason: ${isValid.reason}`,
        }
      }

      // Let the concrete Conditional Order decide about the poll result
      const pollResult = await this.pollValidate(owner, chain, provider)
      if (pollResult) {
        return pollResult
      }

      // Check if the owner authorised the order
      const isAuthorized = await this.isAuthorized(owner, chain, provider)
      if (!isAuthorized) {
        return {
          result: PollResultCode.DONT_TRY_AGAIN,
          reason: `NotAuthorised: Order ${this.id} is not authorised for ${owner} on chain ${chain}`,
        }
      }

      // Lastly, try to get the tradeable order and signature
      const [order, signature] = await composableCow.getTradeableOrderWithSignature(
        owner,
        this.leaf,
        this.offChainInput,
        []
      )

      return {
        result: PollResultCode.SUCCESS,
        order,
        signature,
      }
    } catch (error) {
      return {
        result: PollResultCode.UNEXPECTED_ERROR,
        error: error,
      }
    }
  }

  /**
   * Checks if the owner authorized the conditional order.
   *
   * @param owner The owner of the conditional order.
   * @param chain Which chain to use for the ComposableCoW contract.
   * @param provider An RPC provider for the chain.
   * @returns true if the owner authorized the order, false otherwise.
   */
  public isAuthorized(owner: string, chain: SupportedChainId, provider: providers.Provider): Promise<boolean> {
    const composableCow = getComposableCow(chain, provider)
    return composableCow.callStatic.singleOrders(owner, this.id)
  }

  /**
   * Allow concrete conditional orders to perform additional validation for the poll method.
   *
   * This will allow the concrete orders to decide when an order shouldn't be polled again. For example, if the orders is expired.
   * It also allows to signal when should the next check be done. For example, an order could signal that the validations will fail until a certain time or block.
   *
   * @param owner The owner of the conditional order.
   * @param chain Which chain to use for the ComposableCoW contract.
   * @param provider An RPC provider for the chain.
   *
   * @returns undefined if the concrete order can't make a decision. Otherwise, it returns a PollResultErrors object.
   */
  protected abstract pollValidate(
    owner: string,
    chain: SupportedChainId,
    provider: providers.Provider
  ): Promise<PollResultErrors | undefined>

  /**
   * Convert the struct that the contract expect as an encoded `staticInput` into a friendly data object modeling the smart order.
   *
   * **NOTE**: This should be overridden by any conditional order that requires transformations.
   * This implementation is a no-op if you use the same type for both.
   *
   * @param params {S} Parameters that are passed in to the constructor.
   * @returns {D} The static input for the conditional order.
   */
  abstract transformStructToData(params: S): D

  /**
   * Converts a friendly data object modeling the smart order into the struct that the contract expect as an encoded `staticInput`.
   *
   * **NOTE**: This should be overridden by any conditional order that requires transformations.
   * This implementation is a no-op if you use the same type for both.
   *
   * @param params {S} Parameters that are passed in to the constructor.
   * @returns {D} The static input for the conditional order.
   */
  abstract transformDataToStruct(params: D): S

  /**
   * A helper function for generically deserializing a conditional order.
   * @param s The ABI-encoded `IConditionalOrder.Params` struct to deserialize.
   * @param handler Address of the handler for the conditional order.
   * @param orderDataTypes ABI types for the order's data struct.
   * @param callback A callback function that takes the deserialized data struct and the salt and returns an instance of the class.
   * @returns An instance of the conditional order class.
   */
  protected static deserializeHelper<T>(
    s: string,
    handler: string,
    orderDataTypes: string[],
    callback: (d: any, salt: string) => T
  ): T {
    try {
      // First, decode the `IConditionalOrder.Params` struct
      const { handler: recoveredHandler, salt, staticInput } = decodeParams(s)

      // Second, verify that the recovered handler is the correct handler
      if (!(recoveredHandler == handler)) throw new Error('HandlerMismatch')

      // Third, decode the data struct
      const [d] = utils.defaultAbiCoder.decode(orderDataTypes, staticInput)

      // Create a new instance of the class
      return callback(d, salt)
    } catch (e: any) {
      if (e.message === 'HandlerMismatch') {
        throw e
      } else {
        throw new Error('InvalidSerializedConditionalOrder')
      }
    }
  }
}