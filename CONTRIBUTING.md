# Contributing to suwappu-flywheel 🌀

Thank you for your interest in contributing to suwappu-flywheel! This document provides guidelines and instructions for contributing to our self-sustaining multi-strategy DeFi agent.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Contributing Workflow](#contributing-workflow)
- [Coding Standards](#coding-standards)
- [Testing](#testing)
- [Security](#security)
- [Community](#community)

## Code of Conduct

This project adheres to a code of conduct. By participating, you are expected to uphold this code:

- Be respectful and inclusive
- Welcome newcomers
- Focus on constructive feedback
- Respect different viewpoints and experiences
- Prioritize safety when dealing with financial code

## Getting Started

### Prerequisites

- **Bun** (v1.0 or higher) - [Install Bun](https://bun.sh)
- **Git**
- **Node.js** (v18 or higher, for compatibility)
- A crypto wallet with test funds
- Suwappu API key (free)
- Familiarity with:
  - DeFi protocols (Morpho, Aave, etc.)
  - Base blockchain
  - TypeScript
  - Financial risk management

### Quick Start

1. **Fork the repository** on GitHub
2. **Clone your fork**:
   ```bash
   git clone https://github.com/YOUR_USERNAME/suwappu-flywheel.git
   cd suwappu-flywheel
   ```
3. **Install dependencies**:
   ```bash
   bun install
   ```
4. **Get API key**:
   ```bash
   curl -X POST https://api.suwappu.bot/v1/agent/register \
     -H "Content-Type: application/json" \
     -d '{"name":"dev-agent"}'
   ```
5. **Set up environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your API key and wallet details
   ```
6. **Run tests**:
   ```bash
   bun test
   ```

### Understanding the Strategies

suwappu-flywheel implements 5 DeFi strategies:

1. **Yield Rotation** - Auto-find best Morpho lending APY on Base
2. **Fear-Adjusted DCA** - Buy more ETH when market is fearful
3. **Arb Scanner** - Alert on cross-chain price gaps
4. **Prediction Scout** - Flag mispriced Polymarket contracts
5. **Run All** - Execute all strategies in one pass

⚠️ **Important**: Always use `--dry-run` flag when testing!

## Development Setup

### Local Development

1. **Install Bun** (if not already installed):
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```

2. **Install dependencies**:
   ```bash
   bun install
   ```

3. **Set up environment variables**:
   ```bash
   # Required
   export SUWAPPU_API_KEY=your_api_key_here
   
   # Optional - for testing with your own wallet
   export PRIVATE_KEY=your_test_wallet_private_key
   export RPC_URL=https://mainnet.base.org
   ```

4. **Run in dry-run mode** (recommended for development):
   ```bash
   bun run src/cli.ts run --dry-run
   ```

### Testing Strategies

Test each strategy individually:

```bash
# Test yield strategy (dry-run)
bun run src/cli.ts yield --top 5 --min-apy 5 --dry-run

# Test DCA strategy (dry-run)
bun run src/cli.ts dca --token ETH --amount 10 --dry-run

# Test arb scanner
bun run src/cli.ts arb --tokens ETH,SOL --chains base,arbitrum --dry-run

# Test prediction scout
bun run src/cli.ts predict --top 10 --dry-run
```

### Supported Chains

- **Base** (primary)
- Arbitrum
- Optimism
- Ethereum mainnet
- Solana (for cross-chain arb)

## Project Structure

```
suwappu-flywheel/
├── README.md              # User documentation
├── LICENSE                # MIT License
├── package.json           # Dependencies and scripts
├── .env.example           # Environment template
├── src/
│   ├── cli.ts             # Main CLI entry point
│   ├── strategies/        # Strategy implementations
│   │   ├── yield.ts       # Yield rotation strategy
│   │   ├── dca.ts         # Fear-adjusted DCA
│   │   ├── arb.ts         # Cross-chain arbitrage
│   │   └── predict.ts     # Prediction market scout
│   ├── lib/               # Core utilities
│   │   ├── suwappu.ts     # Suwappu SDK wrapper
│   │   ├── morpho.ts      # Morpho protocol integration
│   │   ├── polymarket.ts  # Polymarket integration
│   │   └── utils.ts       # Helper functions
│   └── types/             # TypeScript type definitions
├── tests/                 # Test suite
└── scripts/               # Build and utility scripts
```

### Key Components

- **CLI Interface**: Command-line tool for running strategies
- **Strategy Modules**: Individual DeFi strategy implementations
- **Suwappu SDK**: Integration with Suwappu agent infrastructure
- **Protocol Integrations**: Morpho, Polymarket, DEX aggregators

## Contributing Workflow

### Branch Naming

- `feature/description` - New features
- `fix/description` - Bug fixes
- `docs/description` - Documentation updates
- `test/description` - Test additions/improvements
- `strategy/description` - New strategy implementations
- `refactor/description` - Code refactoring

Example: `feature/add-aave-yield-strategy`

### Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

Types:
- `feat`: New feature or strategy
- `fix`: Bug fix
- `docs`: Documentation changes
- `test`: Test changes
- `refactor`: Code refactoring
- `perf`: Performance improvements
- `security`: Security-related changes
- `chore`: Maintenance tasks

Examples:
```
feat(strategies): add Aave yield rotation strategy
fix(arb): resolve price calculation error for SOL
security(morpho): add input validation for deposit amounts
docs(readme): update minimum capital requirements
```

### Pull Request Process

1. **Create a branch** for your changes
2. **Make your changes** following our coding standards
3. **Test thoroughly** with `--dry-run` flag
4. **Update documentation** if needed
5. **Submit a pull request** with:
   - Clear title and description
   - Reference to any related issues
   - Test results
   - Risk assessment (for financial strategies)

### PR Review Criteria

- Code follows style guidelines
- Tests pass
- Documentation is updated
- Strategies work correctly in dry-run mode
- No security vulnerabilities introduced
- Financial risks are documented

## Coding Standards

### TypeScript Style

- Use **strict TypeScript** configuration
- Follow **ESLint** rules
- Use **explicit types** for function parameters and returns
- Add **JSDoc comments** for public APIs

Example:
```typescript
/**
 * Calculate optimal yield rotation across Morpho vaults
 * @param {number} minApy - Minimum acceptable APY (percentage)
 * @param {number} topN - Number of top vaults to return
 * @returns {Promise<YieldOpportunity[]>} Array of yield opportunities
 */
async function findBestYields(
  minApy: number,
  topN: number
): Promise<YieldOpportunity[]> {
  // Implementation
}
```

### Error Handling

Always handle errors gracefully, especially for financial operations:

```typescript
try {
  const result = await executeStrategy(params);
  return result;
} catch (error) {
  if (error.code === 'INSUFFICIENT_FUNDS') {
    logger.warn('Insufficient funds for strategy execution');
    return { success: false, error: 'INSUFFICIENT_FUNDS' };
  }
  if (error.code === 'SLIPPAGE_TOO_HIGH') {
    logger.warn('Slippage exceeds threshold, aborting');
    return { success: false, error: 'SLIPPAGE_TOO_HIGH' };
  }
  logger.error('Unexpected error:', error);
  throw error;
}
```

### Strategy Implementation

When adding new strategies:

```typescript
interface Strategy {
  name: string;
  minCapital: number;
  execute: (params: StrategyParams) => Promise<StrategyResult>;
}

const newStrategy: Strategy = {
  name: 'Strategy Name',
  minCapital: 50, // USD
  execute: async (params) => {
    // Implementation
  }
};
```

### Safety Requirements

All strategies must:
- Support `--dry-run` mode
- Validate input parameters
- Check balances before execution
- Implement slippage protection
- Log all transactions
- Handle network errors gracefully

## Testing

### Running Tests

```bash
# Run all tests
bun test

# Run specific test file
bun test yield.test.ts

# Run with coverage
bun test --coverage
```

### Test Structure

```typescript
describe('Yield Strategy', () => {
  test('should find best Morpho yields', async () => {
    const yields = await findBestYields(5, 3);
    
    expect(yields).toHaveLength(3);
    expect(yields[0].apy).toBeGreaterThan(5);
    expect(yields[0].protocol).toBe('Morpho');
  });
  
  test('should respect dry-run mode', async () => {
    const result = await executeStrategy({ dryRun: true });
    expect(result.executed).toBe(false);
    expect(result.simulated).toBe(true);
  });
});
```

### Integration Testing

Test against live protocols (dry-run only):

```bash
# Set test environment
export SUWAPPU_API_KEY=your_test_key
export TEST_WALLET_KEY=your_test_key

# Run integration tests
bun run test:integration
```

### Manual Testing Checklist

- [ ] Strategy runs successfully in dry-run mode
- [ ] Input validation works correctly
- [ ] Error messages are clear and helpful
- [ ] Balance checks prevent over-spending
- [ ] Slippage protection triggers appropriately
- [ ] Logs are informative and actionable

## Security

### Reporting Vulnerabilities

If you discover a security vulnerability:

1. **DO NOT** open a public issue
2. Email security@suwappu.bot with details
3. Include steps to reproduce
4. Allow time for remediation before disclosure

### Security Best Practices

- Never commit private keys or API keys
- Use environment variables for sensitive data
- Validate all user inputs
- Implement rate limiting
- Use HTTPS for all API calls
- Follow OWASP guidelines
- Regular dependency updates

### Financial Safety

- Always use `--dry-run` for testing
- Implement maximum spend limits
- Check balances before transactions
- Use slippage protection
- Verify contract addresses
- Log all financial operations
- Implement circuit breakers

## Community

### Communication Channels

- **GitHub Issues**: Bug reports and feature requests
- **GitHub Discussions**: General questions and ideas
- **Discord**: [Join our community](https://discord.gg/suwappu)
- **Twitter**: [@suwappu](https://twitter.com/suwappu)

### Getting Help

- Check existing [issues](https://github.com/0xSoftBoi/suwappu-flywheel/issues)
- Read the [documentation](https://docs.suwappu.bot)
- Ask in GitHub Discussions
- Join our Discord community

### Recognition

Contributors will be:
- Listed in CONTRIBUTORS.md
- Mentioned in release notes
- Eligible for Suwappu contributor rewards

## Resources

### Learning Materials

- [Suwappu Documentation](https://docs.suwappu.bot)
- [Morpho Protocol](https://docs.morpho.org)
- [Polymarket](https://polymarket.com)
- [Base Documentation](https://docs.base.org)
- [Bun Runtime](https://bun.sh/docs)

### Tools

- [Bun](https://bun.sh/) - Fast JavaScript runtime
- [Viem](https://viem.sh/) - Ethereum library
- [TypeScript](https://www.typescriptlang.org/) - Type system
- [Jest](https://jestjs.io/) - Testing framework

### DeFi Protocols

- [Morpho](https://morpho.org/) - Lending protocol
- [Aave](https://aave.com/) - Lending protocol
- [Polymarket](https://polymarket.com/) - Prediction markets
- [1inch](https://1inch.io/) - DEX aggregator

---

Thank you for contributing to suwappu-flywheel! Together we're building the future of autonomous DeFi agents. 🌀

⚠️ **Remember**: Always use `--dry-run` when testing!

**Happy coding! 🚀**
