// Package config resolves how the updater is wired: from config.toml when it runs on a
// workstation or in CI, and from the environment variables CloudFormation sets when it runs
// as a lambda. The two paths exist because the zip ships nothing but the bootstrap binary —
// a bundled config.toml would mean rebuilding and re-uploading to change a cadence.
package config

import (
	"context"
	"fmt"
	"os"
	"strconv"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	"github.com/pelletier/go-toml/v2"
)

type GitHub struct {
	Owner       string `toml:"owner"`
	Repo        string `toml:"repo"`
	Branch      string `toml:"branch"`
	CommitName  string `toml:"commit_name"`
	CommitEmail string `toml:"commit_email"`
	// Token is only filled on a workstation or in CI. In lambda it stays empty and the real
	// one is read from AWS.GitHubTokenSSM at cold start.
	Token string `toml:"token"`
}

type AWS struct {
	Region           string `toml:"region"`
	Profile          string `toml:"profile"`
	DeploymentBucket string `toml:"deployment_bucket"`
	GitHubTokenSSM   string `toml:"github_token_ssm"`
	Schedule         string `toml:"schedule"`
}

type Updater struct {
	LookbackDays int  `toml:"lookback_days"`
	DryRun       bool `toml:"dry_run"`
}

type Config struct {
	GitHub  GitHub  `toml:"github"`
	AWS     AWS     `toml:"aws"`
	Updater Updater `toml:"updater"`
}

// IsLambda reports whether this process is the lambda runtime rather than a CLI run. The
// variable is set by Lambda itself, so nothing has to be passed in to tell the two apart.
func IsLambda() bool {
	return os.Getenv("AWS_LAMBDA_FUNCTION_NAME") != ""
}

// Load reads config.toml if it is there and then lets the environment override every value,
// so the same binary is configured by a file in local and by CloudFormation in lambda.
func Load(path string) (Config, error) {
	loaded := Config{}

	raw, err := os.ReadFile(path)
	if err == nil {
		if err := toml.Unmarshal(raw, &loaded); err != nil {
			return loaded, fmt.Errorf("%s: %w", path, err)
		}
	} else if !os.IsNotExist(err) {
		return loaded, err
	} else if !IsLambda() {
		return loaded, fmt.Errorf("no existe %s — copia config.example.toml y complétalo", path)
	}

	overrideString(&loaded.GitHub.Owner, "GITHUB_OWNER")
	overrideString(&loaded.GitHub.Repo, "GITHUB_REPO")
	overrideString(&loaded.GitHub.Branch, "GITHUB_BRANCH")
	overrideString(&loaded.GitHub.CommitName, "GITHUB_COMMIT_NAME")
	overrideString(&loaded.GitHub.CommitEmail, "GITHUB_COMMIT_EMAIL")
	overrideString(&loaded.GitHub.Token, "GITHUB_TOKEN")
	overrideString(&loaded.AWS.GitHubTokenSSM, "GITHUB_TOKEN_SSM")
	overrideInt(&loaded.Updater.LookbackDays, "LOOKBACK_DAYS")
	if os.Getenv("DRY_RUN") == "1" {
		loaded.Updater.DryRun = true
	}

	if loaded.GitHub.Branch == "" {
		loaded.GitHub.Branch = "main"
	}
	if loaded.GitHub.Owner == "" || loaded.GitHub.Repo == "" {
		return loaded, fmt.Errorf("faltan github.owner y github.repo")
	}
	return loaded, nil
}

// ResolveToken returns the PAT the commit will be made with. A token already in the config
// wins — that is the local and CI path. Otherwise it comes from SSM, which is the only place
// the lambda has it: an environment variable would show it in the Lambda and CloudFormation
// consoles to anyone who can read the account.
func ResolveToken(ctx context.Context, loaded Config) (string, error) {
	if loaded.GitHub.Token != "" {
		return loaded.GitHub.Token, nil
	}
	if loaded.AWS.GitHubTokenSSM == "" {
		return "", fmt.Errorf("sin github.token ni aws.github_token_ssm: no hay con qué commitear")
	}

	awsCfg, err := awsconfig.LoadDefaultConfig(ctx)
	if err != nil {
		return "", err
	}
	withDecryption := true
	parameter, err := ssm.NewFromConfig(awsCfg).GetParameter(ctx, &ssm.GetParameterInput{
		Name:           &loaded.AWS.GitHubTokenSSM,
		WithDecryption: &withDecryption,
	})
	if err != nil {
		return "", fmt.Errorf("leyendo %s de SSM: %w", loaded.AWS.GitHubTokenSSM, err)
	}
	return *parameter.Parameter.Value, nil
}

func overrideString(target *string, envName string) {
	if value := os.Getenv(envName); value != "" {
		*target = value
	}
}

func overrideInt(target *int, envName string) {
	if value := os.Getenv(envName); value != "" {
		if parsed, err := strconv.Atoi(value); err == nil {
			*target = parsed
		}
	}
}
