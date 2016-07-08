import React from 'react';
import { Collapse } from 'react-bootstrap';

class HierarchicalSelectableSubjectItem extends React.Component {
    constructor(){
        super();
        this.state = { childrenVisible: false };
    }
    toggleChildren(){
        this.setState({childrenVisible: !this.state.childrenVisible});
    }
    render(){
        let childrenVisible = this.state.childrenVisible;

        return (
            <li key={this.props._id}>
                <div>
                    <div className="checkbox" style={{ display: 'inline-block', marginTop: 0, marginBottom: 0 }}>
                        <span style={{ backgroundColor: this.props.backgroundColor, color: this.props.textColor }} className="label label-default">
                            <label onClick={() => this.props.toggleFilteredSubject(this.props._id)} style={{ paddingLeft: 0 }}>
                                <i className={`fa fa-${!!this.props.selectedSubjects[this.props._id] ? 'check-' : ''}square-o`} style={{ marginRight: '5px', minWidth: '10px' }}></i>
                                {this.props.name}
                            </label>
                            { this.props.children.length ? <a style={{ marginLeft: 5, color: 'white' }} onClick={() => this.toggleChildren()}><i className={'fa fa-' + (childrenVisible ? 'angle-up' : 'angle-down')}></i></a> : null }
                        </span>
                    </div>

                    { this.props.children.length ?
                    <Collapse in={childrenVisible}>
                        <div>
                            <HierarchicalSelectableSubjectList style={{ paddingLeft: 25 }} selectedSubjects={this.props.selectedSubjects} toggleFilteredSubject={this.props.toggleFilteredSubject} subjects={this.props.children} />
                        </div>
                    </Collapse> : null }
                </div>
            </li>
        )
    }
}

class HierarchicalSelectableSubjectList extends React.Component {
    render() {
        return (
            <ul style={{ ...(this.props.style || {}), listStyle: 'none' }}>
                { this.props.subjects.map(s => <HierarchicalSelectableSubjectItem selectedSubjects={this.props.selectedSubjects} toggleFilteredSubject={this.props.toggleFilteredSubject} subjects={this.props.subjects} key={s._id} {...s} />) }
            </ul>
        )
    }
}

export default HierarchicalSelectableSubjectList;