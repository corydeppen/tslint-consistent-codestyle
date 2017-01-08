import { isElementAccessExpression, isIdentifier, isPropertyAccessExpression, isStringLiteral } from '../src/typeguard';
import { getPropertyName } from '../src/utils';
import * as ts from 'typescript';
import * as Lint from 'tslint';

const FAIL_MESSAGE = `enum can be declared const`;

export class Rule extends Lint.Rules.AbstractRule {
    public apply(sourceFile: ts.SourceFile): Lint.RuleFailure[] {
        return this.applyWithWalker(new ReturnWalker(sourceFile, this.getOptions()));
    }
}

interface IEnum {
    name: string;
    isConst: boolean;
    occurences: ts.EnumDeclaration[];
    members: Map<string, boolean>;
    canBeConst: boolean;
}

class ReturnWalker extends Lint.RuleWalker {
    private _enums = new Map<string, IEnum>();

    private _getEnumInScope(name: string) {
        return this._enums.get(name);
    }

    private _addEnum(node: ts.EnumDeclaration): IEnum {
        let trackingStructure = this._enums.get(node.name.text);
        if (trackingStructure === undefined) {
            trackingStructure = {
                name: node.name.text,
                isConst: Lint.hasModifier(node.modifiers, ts.SyntaxKind.ConstKeyword),
                occurences: [],
                members: new Map<string, boolean>(),
                canBeConst: true,
            };
            this._enums.set(node.name.text, trackingStructure);
        }
        trackingStructure.occurences.push(node);
        return trackingStructure;
    }

    public walk(sourceFile: ts.SourceFile) {
        const cb = (node: ts.Node) => {
            switch (node.kind) {
                case ts.SyntaxKind.Identifier:
                    return this._checkUsage(<ts.Identifier>node);
                case ts.SyntaxKind.EnumDeclaration:
                    return this.visitEnumDeclaration(<ts.EnumDeclaration>node);
            }
            ts.forEachChild(node, cb);
        };
        ts.forEachChild(sourceFile, cb);

        this._enums.forEach((track) => {
            if (!track.isConst && track.canBeConst) {
                for (const occurence of track.occurences) {
                    const start = occurence.getStart(sourceFile);
                    const fix = this.createFix(new Lint.Replacement(start, 0, 'const '));
                    const end = occurence.name.getEnd();
                    this.addFailureFromStartToEnd(start, end, FAIL_MESSAGE, fix);
                }
            }
        });
    }

    public visitEnumDeclaration(node: ts.EnumDeclaration) {
        const track = this._addEnum(node);
        for (const member of node.members) {
            const isConstMember = track.isConst ||
                    member.initializer === undefined ||
                    this._isConstInitializer(member.initializer, track.members);
            track.canBeConst = track.canBeConst && isConstMember;
            track.members.set(getPropertyName(member.name)!, isConstMember);
        }

        // ignore exported enums for now
        track.canBeConst = track.canBeConst && !Lint.hasModifier(node.modifiers, ts.SyntaxKind.ExportKeyword);
    }

    private _checkUsage(node: ts.Identifier) {
        const parent = node.parent!;
        if (parent.kind === ts.SyntaxKind.PropertyAccessExpression ||
            parent.kind === ts.SyntaxKind.ExportAssignment ||
            isElementAccessExpression(parent) &&
            parent.expression === node && parent.argumentExpression !== undefined &&
            parent.argumentExpression.kind === ts.SyntaxKind.StringLiteral)
            return;
        const track = this._getEnumInScope(node.text);
        if (track !== undefined)
            track.canBeConst = false;
    }

    private _isConstInitializer(initializer: ts.Expression, members: Map<string, boolean>): boolean {
        let isConst = true;
        const cb = (current: ts.Expression) => {
            if (isIdentifier(current)) {
                if (!members.get(current.text))
                    isConst = false;
                return;
            }
            if (isPropertyAccessExpression(current)) {
                if (isIdentifier(current.expression)) {
                    const track = this._getEnumInScope(current.expression.text);
                    if (track !== undefined && track.members.get(current.name.text)) {
                        return;
                    }
                }
                isConst = false;
            } else if (isElementAccessExpression(current)) {
                if (isIdentifier(current.expression)) {
                    const track = this._getEnumInScope(current.expression.text);
                    if (track !== undefined) {
                        if (current.argumentExpression !== undefined &&
                            isStringLiteral(current.argumentExpression)) {
                            if (track.members.get(current.argumentExpression.text))
                                return;
                        } else {
                            track.canBeConst = false;
                        }
                    }
                }
                isConst = false;
            }

            ts.forEachChild(current, cb);
        };

        cb(initializer);
        return isConst;
    }
}
