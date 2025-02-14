import path from "path";
import fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";

import { Plugin, PluginServiceApi } from "@cloudbase/framework-core";
import { StaticBuilder } from "@cloudbase/static-builder";
import { StaticDeployer } from "@cloudbase/static-deployer";

const DEFAULT_INPUTS = {
  outputPath: "dist",
  cloudPath: "/",
  ignore: [".git", ".github", "node_modules", "cloudbaserc.js"],
};

class WebsitePlugin extends Plugin {
  protected builder: StaticBuilder;
  protected deployer: StaticDeployer;
  protected resolvedInputs: any;
  protected buildOutput: any;
  // 静态托管信息
  protected website: any;

  constructor(
    public name: string,
    public api: PluginServiceApi,
    public inputs: any
  ) {
    super(name, api, inputs);

    this.resolvedInputs = resolveInputs(this.inputs);
    this.builder = new StaticBuilder({
      projectPath: this.api.projectPath,
      copyRoot: path.resolve(
        this.api.projectPath,
        this.resolvedInputs.outputPath
      ),
    });
    this.deployer = new StaticDeployer({
      cloudbaseManager: this.api.cloudbaseManager,
    });
  }

  /**
   * 初始化
   */
  async init() {
    this.api.logger.debug("WebsitePlugin: init", this.resolvedInputs);
    this.api.logger.info(
      "Website 插件会自动开启静态网页托管能力，需要当前环境为 [按量计费] 模式"
    );
    this.api.logger.info(
      `Website 插件会部署应用资源到当前静态托管的 ${this.resolvedInputs.cloudPath} 目录下`
    );
    await Promise.all([this.ensureEnableHosting(), this.ensurePostPay()]);
  }

  /**
   * 编译为 SAM 模板
   */
  async compile() {
    return {
      EnvType: "PostPay",
      Resources: {
        Website: {
          Type: "CloudBase::StaticStore",
          Properties: {
            Description:
              "为开发者提供静态网页托管的能力，包括HTML、CSS、JavaScript、字体等常见资源。",
            // @TODO 指定构建产物，云端路径，过滤文件
          },
        },
      },
    };
  }

  /**
   * 删除资源
   */
  async remove() {}

  /**
   * 生成代码
   */
  async genCode() {}

  /**
   * 构建
   */
  async build() {
    // cloudPath 会影响publicpath 和 baseroute 等配置，需要处理
    this.api.logger.debug("WebsitePlugin: build", this.resolvedInputs);
    await this.installPackage();

    const { outputPath, cloudPath, buildCommand } = this.resolvedInputs;

    if (buildCommand) {
      await promisify(exec)(buildCommand);
    }

    this.buildOutput = await this.builder.build(["**", "!**/node_modules/**"], {
      path: cloudPath,
    });
  }

  /**
   * 部署
   */
  async deploy() {
    this.api.logger.debug(
      "WebsitePlugin: deploy",
      this.resolvedInputs,
      this.buildOutput
    );

    const deployResult = await Promise.all(
      this.buildOutput.static.map((item: any) =>
        this.deployer.deploy({
          localPath: item.src,
          cloudPath: item.cloudPath,
          ignore: item.ignore,
        })
      )
    );

    const url = this.api.genClickableLink(
      `https://${this.website.cdnDomain + this.resolvedInputs.cloudPath}`
    );
    this.api.logger.info(
      `${this.api.emoji("🚀")} 网站部署成功, 访问地址：${url}`
    );

    await this.builder.clean();

    return deployResult;
  }

  /**
   * 安装依赖
   */
  async installPackage() {
    try {
      if (fs.statSync("package.json")) {
        this.api.logger.info("npm install");
        return promisify(exec)("npm install");
      }
    } catch (e) {}
  }

  async ensurePostPay() {
    const res = await this.api.cloudApi.tcbService.request("DescribeEnvs");
    let env = res.EnvList && res.EnvList[0];

    if (!env) {
      throw new Error(`当前账号下不存在 ${this.api.envId} 环境`);
    }

    if (env.PayMode !== "postpaid") {
      throw new Error(
        "网站托管当前只能部署到按量付费的环境下，请先在控制台切换计费方式"
      );
    }
  }

  /**
   * 确保开启了静态托管
   */
  async ensureEnableHosting(): Promise<any> {
    const Hosting = this.api.resourceProviders?.hosting;
    const envId = this.api.envId;

    if (!Hosting) {
      return;
    }

    let website;

    try {
      const hostingRes = await Hosting.getHostingInfo({ envId });

      if (!hostingRes.data.length) {
        throw new Error("未开通静态托管");
      }

      website = hostingRes.data[0];
    } catch (e) {
      this.api.logger.debug(e);

      await Hosting.enableHosting({ envId });

      this.api.logger.info("⏳ 托管资源初始化中, 预计等待 3 分钟");

      await wait(3 * 60 * 1000);
      return this.ensureEnableHosting();
    }

    this.website = website;

    return website;
  }
}

function resolveInputs(inputs: any) {
  return Object.assign({}, DEFAULT_INPUTS, inputs);
}

function wait(time: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, time);
  });
}

function ensureWithSlash(dir: string): string {
  if (!dir) return "";
  return dir[dir.length - 1] === "/" ? dir : dir + "/";
}

export const plugin = WebsitePlugin;
