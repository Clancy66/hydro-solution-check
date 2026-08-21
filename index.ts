import { _, db, PRIV, Handler, Context, Types, param, ForbiddenError, ObjectId, moment, SolutionModel } from 'hydrooj';

// 1. 定义审批状态枚举
enum CheckStatus {
    PENDING = 0,  // 待审批
    APPROVED = 1, // 已通过
    REJECTED = 2  // 已拒绝
}

// 2. 扩展 Hydro 内部的数据库接口定义
interface SolutionCheckDoc {
    _id?: ObjectId;
    pid: string;
    sid: ObjectId;      // 对应 SolutionModel 的 _id
    owner: number;      // 提交者 UID
    status: CheckStatus;// 审批状态
    reason?: string;    // 拒绝原因
    createdAt: Date;
}

declare module 'hydrooj' {
    interface Model {
        solution_check: typeof SolutionCheckModel;
    }
    interface Collections {
        solution_check: SolutionCheckDoc;
    }
}

const collsolution_check = db.collection('solution_check');

// 3. 创建审批模型的后台逻辑
class SolutionCheckModel {
    static coll = collsolution_check;

    // 创建一条审批记录
    static async create(pid: string, sid: ObjectId, owner: number) {
        return await this.coll.insertOne({
            pid,
            sid,
            owner,
            status: CheckStatus.PENDING,
            createdAt: new Date()
        });
    }

    // 更新审批表状态
    static async update(id: ObjectId, status: CheckStatus, reason = '') {
        const check = await this.coll.findOne({ sid: id });
        if (!check) throw new Error('审批记录不存在');

        await this.coll.updateOne({ sid: id }, {
            $set: { status, reason, createdAt: new Date() }
        });
    }

    // 删除一条审批记录
    static async delete(id: ObjectId) {
        const check = await this.coll.findOne({ sid: id });
        if (!check) throw new Error('审批记录不存在');

        await this.coll.deleteOne({ sid: id});
    }

    // 获取审批列表
    static async getList(status?: CheckStatus, page = 1, limit = 20) {
        const query: any = { };
        if (status !== undefined) query.status = status;
        return await this.coll.find(query)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .toArray();
    }
}

global.Hydro.model.solution_check = SolutionCheckModel;

// 4. 路由处理器：用户查看自己的申请，或管理员进行审批
class SolutionCheckHandler extends Handler {
    // 权限检查中间件
    async _prepare() {
        // 通用准备逻辑（如果需要）
    }
}

// 列表与管理接口
class SolutionCheckManageHandler extends SolutionCheckHandler {
    // 获取审批列表（管理员看全部，普通用户看自己的）
    @param('status', Types.Int, true)
    @param('page', Types.PositiveInt, true)
    async get(page = 1) {
        let ddocs;
        if (this.user.hasPriv(PRIV.PRIV_SET_PERM)) {
            ddocs = await SolutionCheckModel.getList(CheckStatus.PENDING, page);
        } else {
            // 普通用户只能查自己的
            ddocs = await SolutionCheckModel.coll.find({ owner: this.user._id }).toArray();
        }

        this.response.body = { ddocs };
        this.response.template = 'solution_manage.html';
    }

    async post(args: any) {
        if (!this.user.hasPriv(PRIV.PRIV_SET_PERM)) {
            throw new ForbiddenError('发布指令遭拒：您非本域高级管理人员！');
        }
    }

    // 提交审批结果（仅限管理员）
    async postSubmitAudit() {
        if (!this.user.hasPriv(PRIV.PRIV_SET_PERM)) {
            throw new ForbiddenError('你没有审批题解的权限');
        }

        const body = this.args || this.request?.body || (this as any).body || {};
        const { sid, action, reason } = body;

        try {
            // 将字符串 ID 转换为 MongoDB 的 ObjectId 对象
            const targetSid = new ObjectId(sid);
            const status = action === 'approve' ? CheckStatus.APPROVED : CheckStatus.REJECTED;
            
            // 执行审批操作
            await SolutionCheckModel.update(targetSid, status, reason || '');
            
            this.response.body = { status: 'success' };
        } catch (e: any) {
            this.response.body = { status: 'error', message: e.message || '审批执行异常' };
        }
    }
}

// 5. 插件入口：拦截题解提交并注册路由
export async function apply(ctx: Context) {
    // 当用户提交题解时，如果题解已达到 15 个则拒绝新题解
    ctx.on('handler/before/ProblemSolution#post', async (that: any) => {
        const userSolutions = await SolutionModel.getMulti(that.args.domainId, Number(that.args.pid), { owner: that.user._id }).toArray();
        if (userSolutions.length > 0) {
            throw new Error('该题目你已写过一篇题解');
        }
        const solutions = await SolutionModel.getMulti(that.args.domainId, Number(that.args.pid)).toArray();
        if (solutions.length >= 15) {
            throw new Error('该题目的题解数量已达上限，不再接受新题解。');
        }
    });
    
    // 当用户提交题解时，强制将其 status 设为 PENDING，并丢进审批流
    ctx.on('handler/after/ProblemSolution#post', async (that: any) => {
        // 普通用户创建、修改题解强制进入审批流，默认拥有 PRIV_SET_PERM 权限的用户为管理员
        if (that.args.operation === 'submit' && that.response !== null) {
            if (!that.user.hasPriv(PRIV.PRIV_SET_PERM)) {
                await SolutionCheckModel.create(that.args.pid, new ObjectId(that.response.body.psid), that.user._id);
            }
        }
        if (that.args.operation === 'edit_solution' && that.response !== null) {
            if (!that.user.hasPriv(PRIV.PRIV_SET_PERM)) {
                await SolutionCheckModel.update(new ObjectId(that.args.psid), CheckStatus.PENDING, '');
            }
        }
        // 删除题解时同步删除相关审批流
        if (that.args.operation === 'delete_solution' && that.response !== null) {
            if (!that.user.hasPriv(PRIV.PRIV_SET_PERM)) {
                await SolutionCheckModel.delete(new ObjectId(that.args.psid));
            }
        }
    });

    // 拦截题解查看，强行筛掉状态不是【已通过】的题解
    ctx.on('handler/after/ProblemSolution#get', async (that: any) => {
        const psdocs = that.response.body.psdocs;
        if (psdocs !== null && psdocs !== undefined){
            const sids = psdocs.map((doc: any) => doc._id);
            const checks = await SolutionCheckModel.coll.find({
                sid: { $in: sids }
            }).toArray();

            const checkMap = new Map(checks.map(c => [c.sid.toString(), c.status]));
            const reasonMap = new Map(checks.map(c => [c.sid.toString(), c.reason]));
            const curUid = that.user?._id;
            const isMod = that.user?.hasPriv(PRIV.PRIV_SET_PERM);

            const filteredDocs = [];

            for (const doc of psdocs) {
                const sidStr = doc._id.toString();
                const status = checkMap.get(sidStr);

                // 1. 老数据，或者管理员发布的
                if (status === undefined) {
                    filteredDocs.push(doc);
                    continue;
                }

                // 2. 通过审核的
                if (status === CheckStatus.APPROVED) {
                    filteredDocs.push(doc);
                    continue;
                }

                // 3. 被拒后超过七天未修改的题解将自动删除
                if (status === CheckStatus.REJECTED) {
                    // 注意：此处建议加上 status 过滤和排序，防止查错记录
                    const check = await SolutionCheckModel.coll.findOne(
                        { sid: doc._id, status: CheckStatus.REJECTED },
                        { sort: { createdAt: -1 } }
                    );
                    
                    if (check && moment(check.createdAt).add(7, 'days').isBefore(moment())) {
                        await SolutionCheckModel.delete(doc._id);
                        await SolutionModel.del(doc.domainId, doc._id);

                        that.response.body.pscount -= 1;
                        continue; // 跳过，不加入 filteredDocs
                    }
                }

                // 4. 权限校验（本人或管理员可见待审/7天内被拒的数据）
                if (curUid && (doc.owner === curUid || isMod)) {
                    doc.checkStatus = status;
                    doc.reason = reasonMap.get(sidStr);
                    filteredDocs.push(doc);
                    continue;
                }
                
                // 5. 其他人无权查看
                that.response.body.pscount -= 1;
            }

            that.response.body.psdocs = filteredDocs;
        }
    });

    ctx.Route('solution_check_manage', '/solution/check', SolutionCheckManageHandler, PRIV.PRIV_USER_PROFILE);

    ctx.injectUI('UserDropdown', 'solution_check_manage', { icon: 'book', displayName: '题解审批' }, PRIV.PRIV_USER_PROFILE);
}
